// Map-reduce summarization for documents too long for one Groq request under
// the per-minute token (TPM) cap. Nothing is truncated: the text is split into
// chunks that each fit well inside the budget, every chunk is summarized, and
// the partial summaries are merged level by level until one final summary is
// left. Requests are paced by a sliding-window limiter, and a 429 from Groq
// (e.g. because voice summaries used the same quota) is waited out and retried.

const config = require("../config");
const { GroqRateLimitError } = require("./groqClient");
const { splitIntoChunks } = require("./textChunker");
const { createTpmLimiter } = require("./tpmLimiter");
const { documentLlm } = require("./summarize");

const MAX_RATE_LIMIT_RETRIES = 4;
const DEFAULT_RETRY_WAIT_MS = 20 * 1000;
const MAX_REDUCE_LEVELS = 8;
const BATCH_SEPARATOR = "\n\n";

/**
 * Derives per-request sizes from the TPM budget. Requests are sized to about
 * half the per-minute budget so two fit in every window, which keeps the
 * limiter close to fully used without ever asking for more than it can get.
 */
function deriveBudget({ tpm, charsPerToken, promptChars, maxOut }) {
  const tokens = (chars) => Math.ceil(chars / charsPerToken);
  const requestTokens = Math.floor(tpm / 2) - 150;
  const min = 500;
  return {
    requestTokens,
    chunkChars: Math.max(min, Math.floor((requestTokens - tokens(promptChars.map) - maxOut.map) * charsPerToken)),
    batchChars: Math.max(min, Math.floor((requestTokens - tokens(promptChars.combine) - maxOut.final) * charsPerToken)),
    // Ceiling for a merge request when the usual size can't fit two partial
    // summaries: 80% of what the limiter would ever let through in a minute.
    hardBatchChars: Math.max(
      min,
      Math.floor((Math.floor(tpm * 0.9 * 0.8) - tokens(promptChars.combine) - maxOut.final) * charsPerToken)
    ),
    // Last-resort ceiling for a merge request: everything the limiter would
    // let through in one minute. Only used when nothing smaller can fit two
    // partial summaries (the estimate is conservative, so real requests are
    // smaller than this).
    absoluteBatchChars: Math.max(
      min,
      Math.floor((Math.floor(tpm * 0.9) - tokens(promptChars.combine) - maxOut.final) * charsPerToken)
    ),
    // One-request path: only when it fits comfortably in a single window.
    singleShotChars: Math.max(
      min,
      Math.floor((Math.floor(tpm * 0.7) - tokens(promptChars.single) - maxOut.single) * charsPerToken)
    ),
  };
}

function packBatches(items, maxChars) {
  const batches = [];
  let current = [];
  let length = 0;
  for (const item of items) {
    const added = (current.length ? BATCH_SEPARATOR.length : 0) + item.length;
    if (current.length && length + added > maxChars) {
      batches.push(current);
      current = [item];
      length = item.length;
    } else {
      current.push(item);
      length += added;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * @param {string} text
 * @param {object} deps
 * @param {object} deps.llm             { single, mapChunk, combine, promptChars, maxOut } (see summarize.js)
 * @param {object} deps.limiter         from createTpmLimiter
 * @param {object} deps.budget          from deriveBudget
 * @param {number} deps.charsPerToken
 * @param {(p: {stage: string, done: number, total: number, etaSeconds: number}) => void} [deps.onProgress]
 * @returns {Promise<{ text: string, calls: number, chunks: number }>}
 */
async function summarizeDocument(text, deps) {
  const {
    llm,
    limiter,
    budget,
    charsPerToken,
    onProgress = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console,
  } = deps;

  const tokens = (chars) => Math.ceil(chars / charsPerToken);
  // Rough remaining-time estimate: tokens still to be sent / tokens per minute.
  const eta = (remainingTokens) => Math.ceil((remainingTokens / limiter.cap) * 60);
  let calls = 0;

  async function call(fn, estimatedTokens) {
    for (let attempt = 0; ; attempt++) {
      const entry = await limiter.acquire(estimatedTokens);
      try {
        calls += 1;
        const result = await fn();
        limiter.settle(entry, result.totalTokens);
        return result.text;
      } catch (err) {
        if (err instanceof GroqRateLimitError && attempt < MAX_RATE_LIMIT_RETRIES) {
          const wait = err.retryAfterMs || DEFAULT_RETRY_WAIT_MS;
          log.warn(`[longSummarize] Groq 429, waiting ${wait}ms before retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}`);
          await sleep(wait + 500);
          continue;
        }
        throw err;
      }
    }
  }

  const cost = {
    single: (chars) => tokens(chars) + tokens(llm.promptChars.single) + llm.maxOut.single,
    map: (chars) => tokens(chars) + tokens(llm.promptChars.map) + llm.maxOut.map,
    combine: (chars, final) =>
      tokens(chars) + tokens(llm.promptChars.combine) + (final ? llm.maxOut.final : llm.maxOut.combine),
  };

  if (text.length <= budget.singleShotChars) {
    onProgress({ stage: "final", done: 0, total: 1, etaSeconds: eta(cost.single(text.length)) });
    const summary = await call(() => llm.single(text), cost.single(text.length));
    return { text: summary, calls, chunks: 1 };
  }

  const chunks = splitIntoChunks(text, budget.chunkChars);
  const mapCosts = chunks.map((c) => cost.map(c.length));
  // Merging partial summaries costs roughly a quarter of the map phase again.
  const reduceEstimate = Math.ceil(mapCosts.reduce((a, b) => a + b, 0) * 0.25);
  log.log(`[longSummarize] ${text.length} chars -> ${chunks.length} chunks of <= ${budget.chunkChars} chars`);

  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const remaining = mapCosts.slice(i).reduce((a, b) => a + b, 0) + reduceEstimate;
    onProgress({ stage: "map", done: i, total: chunks.length, etaSeconds: eta(remaining) });
    partials.push(await call(() => llm.mapChunk(chunks[i], { index: i + 1, total: chunks.length }), mapCosts[i]));
  }

  // Each level must merge at least two partials per batch or it can't shrink.
  // Escalation, in order, until two partials fit in one merge request:
  //   1. the usual batch size, lifted just enough to fit two of the largest
  //      partials (up to the hard ceiling, 80% of the per-minute cap);
  //   2. the absolute ceiling (100% of the per-minute cap, estimated
  //      conservatively);
  //   3. condense every partial on its own with the TIGHT prompt, which has a
  //      much smaller output cap, so the result is guaranteed to be small enough
  //      to pair. (A plain merge of a single partial would come back about the
  //      same size, which is why this needs its own prompt and cap.)
  // Only if that still can't fit two does it give up, with the sizes in the error.
  const hardChars = budget.hardBatchChars || budget.batchChars;
  const absoluteChars = Math.max(hardChars, budget.absoluteBatchChars || hardChars);
  const limitFor = (items, ceiling) => {
    const largestPair = 2 * Math.max(...items.map((p) => p.length)) + BATCH_SEPARATOR.length;
    return Math.min(ceiling, Math.max(budget.batchChars, largestPair));
  };
  const shrinks = (items, batches) => batches.length === 1 || batches.length < items.length;
  const sizes = (items) => items.map((p) => p.length).join(",");

  function pack(items) {
    for (const ceiling of [hardChars, absoluteChars]) {
      const limit = limitFor(items, ceiling);
      const batches = packBatches(items, limit);
      if (shrinks(items, batches)) return { batches, limit };
    }
    return { batches: null, limit: limitFor(items, absoluteChars) };
  }

  let level = partials;
  for (let depth = 0; depth < MAX_REDUCE_LEVELS; depth++) {
    let { batches, limit } = pack(level);

    if (!batches) {
      log.warn(
        `[longSummarize] level ${depth}: no two partials fit in ${limit} chars (sizes ${sizes(level)}); condensing each one tightly first`
      );
      const condensed = [];
      for (let i = 0; i < level.length; i++) {
        onProgress({
          stage: "combine",
          done: i,
          total: level.length,
          etaSeconds: eta(level.slice(i).reduce((sum, p) => sum + cost.combine(p.length, false), 0)),
        });
        condensed.push(
          await call(() => llm.combine([level[i]], { final: false, tight: true }), cost.combine(level[i].length, false))
        );
      }
      level = condensed;
      ({ batches, limit } = pack(level));
      if (!batches) {
        throw new Error(
          `Long-document summary did not converge (${level.length} partial summaries of ${sizes(level)} chars cannot be merged within ${limit} chars)`
        );
      }
    }

    log.log(`[longSummarize] level ${depth}: ${level.length} partials (sizes ${sizes(level)}) -> ${batches.length} batch(es), limit ${limit} chars`);

    if (batches.length === 1) {
      const joined = batches[0].join(BATCH_SEPARATOR);
      onProgress({ stage: "final", done: 0, total: 1, etaSeconds: eta(cost.combine(joined.length, true)) });
      const summary = await call(() => llm.combine(batches[0], { final: true }), cost.combine(joined.length, true));
      return { text: summary, calls, chunks: chunks.length };
    }

    const next = [];
    for (let b = 0; b < batches.length; b++) {
      const remaining = batches
        .slice(b)
        .reduce((sum, batch) => sum + cost.combine(batch.join(BATCH_SEPARATOR).length, false), 0);
      // Plus one final merge afterwards, sized like a full batch.
      onProgress({
        stage: "combine",
        done: b,
        total: batches.length,
        etaSeconds: eta(remaining + cost.combine(budget.batchChars, true)),
      });
      next.push(await call(() => llm.combine(batches[b], { final: false }), cost.combine(batches[b].join(BATCH_SEPARATOR).length, false)));
    }
    level = next;
  }

  throw new Error("Long-document summary needed too many merge levels");
}

// --- Default wiring used by the bot: real model calls, a limiter shared by all
// concurrent summaries, budget derived from config.

const sharedLimiter = createTpmLimiter({ limit: config.GROQ_TPM_LIMIT });
const defaultBudget = deriveBudget({
  tpm: config.GROQ_TPM_LIMIT,
  charsPerToken: config.CHARS_PER_TOKEN_ESTIMATE,
  promptChars: documentLlm.promptChars,
  maxOut: documentLlm.maxOut,
});

function summarizeWithDefaults(text, onProgress) {
  return summarizeDocument(text, {
    llm: documentLlm,
    limiter: sharedLimiter,
    budget: defaultBudget,
    charsPerToken: config.CHARS_PER_TOKEN_ESTIMATE,
    onProgress,
  });
}

module.exports = {
  deriveBudget,
  packBatches,
  summarizeDocument,
  summarizeLongDocument: summarizeWithDefaults,
  defaultBudget,
};

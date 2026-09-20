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

  let level = partials;
  for (let depth = 0; depth < MAX_REDUCE_LEVELS; depth++) {
    const batches = packBatches(level, budget.batchChars);
    const isFinal = batches.length === 1;

    if (isFinal) {
      const joined = batches[0].join(BATCH_SEPARATOR);
      onProgress({ stage: "final", done: 0, total: 1, etaSeconds: eta(cost.combine(joined.length, true)) });
      const summary = await call(() => llm.combine(batches[0], { final: true }), cost.combine(joined.length, true));
      return { text: summary, calls, chunks: chunks.length };
    }

    if (batches.length >= level.length) {
      throw new Error("Long-document summary did not converge (partial summaries are larger than a batch)");
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

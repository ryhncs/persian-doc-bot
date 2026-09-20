process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveBudget, packBatches, summarizeDocument } = require("../src/services/longSummarize");
const { createTpmLimiter } = require("../src/services/tpmLimiter");
const { GroqRateLimitError } = require("../src/services/groqClient");
const { createClock, silentLog } = require("./helpers");

const PROMPT_CHARS = { single: 450, map: 430, combine: 600 };
const MAX_OUT = { single: 1300, map: 800, combine: 900, final: 1300 };
const CHARS_PER_TOKEN = 1.6;
const TPM = 6000;

function longText(chars) {
  const sentences = [];
  let i = 0;
  while (sentences.join(" ").length < chars) {
    sentences.push(`Sentence number ${i++} explains a distinct idea about the topic at hand.`);
  }
  return sentences.join("\n");
}

// Deterministic fake model. Each call returns a short marker and "uses" a
// realistic number of tokens (input + a modest completion).
function fakeLlm(overrides = {}, { partialChars = 20 } = {}) {
  const seen = { single: [], mapChunk: [], combine: [] };
  const tokens = (s) => Math.ceil(s.length / CHARS_PER_TOKEN);
  const llm = {
    promptChars: PROMPT_CHARS,
    maxOut: MAX_OUT,
    seen,
    async single(text) {
      seen.single.push(text);
      return { text: "SINGLE", totalTokens: tokens(text) + 300 + 400 };
    },
    async mapChunk(chunk) {
      seen.mapChunk.push(chunk);
      const label = `- point from chunk ${seen.mapChunk.length} `;
      return { text: label + "x".repeat(partialChars), totalTokens: tokens(chunk) + 300 + 250 };
    },
    async combine(partials, { final }) {
      seen.combine.push({ partials, final });
      const joined = partials.join("\n\n");
      return { text: final ? "FINAL SUMMARY" : `- merged(${partials.length})`, totalTokens: tokens(joined) + 300 + 300 };
    },
    ...overrides,
  };
  return llm;
}

function harness(llm, { tpm = TPM } = {}) {
  const clock = createClock(0);
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
    clock.advance(ms);
  };
  const limiter = createTpmLimiter({ limit: tpm, now: clock, sleep });

  // Track the true per-minute total of settled usage as the run progresses.
  let peak = 0;
  const realAcquire = limiter.acquire;
  limiter.acquire = async (n) => {
    const entry = await realAcquire(n);
    peak = Math.max(peak, limiter.used());
    return entry;
  };

  const budget = deriveBudget({ tpm, charsPerToken: CHARS_PER_TOKEN, promptChars: PROMPT_CHARS, maxOut: MAX_OUT });
  const events = [];
  const run = (text) =>
    summarizeDocument(text, {
      llm,
      limiter,
      budget,
      charsPerToken: CHARS_PER_TOKEN,
      onProgress: (p) => events.push(p),
      sleep,
      log: silentLog,
    });
  return { run, clock, sleeps, events, budget, limiter, peak: () => peak };
}

test("budget: requests are sized to about half the per-minute budget, single-shot only when comfortable", () => {
  const b = deriveBudget({ tpm: TPM, charsPerToken: CHARS_PER_TOKEN, promptChars: PROMPT_CHARS, maxOut: MAX_OUT });
  assert.equal(b.requestTokens, 2850);
  // A full chunk request (prompt + chunk + max completion) stays within the per-request budget.
  const chunkRequest = Math.ceil(PROMPT_CHARS.map / CHARS_PER_TOKEN) + Math.ceil(b.chunkChars / CHARS_PER_TOKEN) + MAX_OUT.map;
  assert.ok(chunkRequest <= b.requestTokens, `chunk request ${chunkRequest} > ${b.requestTokens}`);
  const batchRequest = Math.ceil(PROMPT_CHARS.combine / CHARS_PER_TOKEN) + Math.ceil(b.batchChars / CHARS_PER_TOKEN) + MAX_OUT.final;
  assert.ok(batchRequest <= b.requestTokens);
  assert.ok(b.singleShotChars > b.chunkChars, "documents that fit comfortably still go in one request");
});

test("a short document is summarized in a single request", async () => {
  const llm = fakeLlm();
  const h = harness(llm);
  const result = await h.run("A short document.\nJust two lines.");
  assert.equal(result.text, "SINGLE");
  assert.equal(result.calls, 1);
  assert.equal(llm.seen.mapChunk.length, 0);
});

test("a long document is split, every chunk is summarized, and one final summary comes back", async () => {
  const llm = fakeLlm();
  const h = harness(llm);
  const text = longText(30000);
  const result = await h.run(text);

  assert.equal(result.text, "FINAL SUMMARY");
  assert.ok(llm.seen.mapChunk.length > 5, "was split into several chunks");
  assert.equal(llm.seen.combine.filter((c) => c.final).length, 1, "exactly one final combine");
  assert.equal(llm.seen.combine.at(-1).final, true, "and it is the last call");
  assert.equal(result.chunks, llm.seen.mapChunk.length);
});

test("nothing is truncated: the chunks together contain the whole document", async () => {
  const llm = fakeLlm();
  const h = harness(llm);
  const text = longText(25000);
  await h.run(text);

  const squash = (s) => s.replace(/\s+/g, "");
  assert.equal(squash(llm.seen.mapChunk.join("")), squash(text));
  for (const chunk of llm.seen.mapChunk) assert.ok(chunk.length <= h.budget.chunkChars);
});

test("partial summaries are merged in order, in batches that fit, before the final combine", async () => {
  // Realistic partial size (about 700 chars), so they can't all fit one batch.
  const llm = fakeLlm({}, { partialChars: 700 });
  const h = harness(llm);
  await h.run(longText(40000));

  const chunkCount = llm.seen.mapChunk.length;
  const intermediate = llm.seen.combine.filter((c) => !c.final);
  assert.ok(intermediate.length >= 2, "many chunks need intermediate merge levels");
  assert.ok(llm.seen.combine.at(-1).final);

  // First-level merges consume every map partial exactly once, in order.
  const firstLevel = intermediate.filter((c) => c.partials[0].startsWith("- point from chunk")).flatMap((c) => c.partials);
  const expected = Array.from({ length: chunkCount }, (_, i) => `- point from chunk ${i + 1} ${"x".repeat(700)}`);
  assert.deepEqual(firstLevel, expected);

  // Every merge input fits the batch budget.
  for (const c of llm.seen.combine) {
    assert.ok(c.partials.join("\n\n").length <= h.budget.batchChars, "merge input fits the batch budget");
  }
});

test("pacing: the trailing-minute token total never exceeds the limiter cap while a long document is processed", async () => {
  const llm = fakeLlm();
  const h = harness(llm);
  await h.run(longText(30000));

  assert.ok(h.peak() <= h.limiter.cap, `peak ${h.peak()} exceeded cap ${h.limiter.cap}`);
  assert.ok(h.sleeps.length > 0, "it had to wait for the window several times");
  assert.ok(h.clock() > 60 * 1000, "a big document takes more than a minute of (virtual) time");
});

test("progress is reported per stage with a shrinking time estimate", async () => {
  const llm = fakeLlm();
  const h = harness(llm);
  await h.run(longText(20000));

  const map = h.events.filter((e) => e.stage === "map");
  assert.ok(map.length >= 3);
  assert.deepEqual(map.map((e) => e.done), map.map((_, i) => i));
  assert.equal(new Set(map.map((e) => e.total)).size, 1);
  for (let i = 1; i < map.length; i++) assert.ok(map[i].etaSeconds <= map[i - 1].etaSeconds, "estimate does not grow");
  assert.equal(h.events.at(-1).stage, "final");
});

test("a Groq 429 is waited out using Retry-After and then retried", async () => {
  let failures = 1;
  const llm = fakeLlm({
    async mapChunk(chunk) {
      if (failures-- > 0) throw new GroqRateLimitError("rate limited", 7000);
      return { text: "- ok", totalTokens: 1500 };
    },
  });
  const h = harness(llm);
  const result = await h.run(longText(9000));

  assert.equal(result.text, "FINAL SUMMARY");
  assert.ok(h.sleeps.some((ms) => ms >= 7000), "slept at least the Retry-After");
});

test("a 429 with no Retry-After falls back to a default wait", async () => {
  let failures = 1;
  const llm = fakeLlm({
    async mapChunk() {
      if (failures-- > 0) throw new GroqRateLimitError("rate limited");
      return { text: "- ok", totalTokens: 1500 };
    },
  });
  const h = harness(llm);
  await h.run(longText(9000));
  assert.ok(h.sleeps.some((ms) => ms >= 20000));
});

test("gives up after repeated 429s and lets the error reach the caller", async () => {
  const llm = fakeLlm({
    async mapChunk() {
      throw new GroqRateLimitError("still limited", 1000);
    },
  });
  const h = harness(llm);
  await assert.rejects(() => h.run(longText(9000)), GroqRateLimitError);
});

test("other errors are not retried", async () => {
  let calls = 0;
  const llm = fakeLlm({
    async mapChunk() {
      calls++;
      throw new Error("boom");
    },
  });
  const h = harness(llm);
  await assert.rejects(() => h.run(longText(9000)), /boom/);
  assert.equal(calls, 1);
});

test("refuses to loop forever if partial summaries can't shrink", async () => {
  const llm = fakeLlm({
    async mapChunk() {
      return { text: "x".repeat(5000), totalTokens: 1500 }; // each partial bigger than a whole batch
    },
    async combine(partials, { final }) {
      return { text: final ? "FINAL" : "x".repeat(5000), totalTokens: 1500 };
    },
  });
  const h = harness(llm);
  await assert.rejects(() => h.run(longText(9000)), /did not converge/);
});

test("packBatches keeps order, respects the size limit, and never drops an oversized item", () => {
  const batches = packBatches(["aaaa", "bbbb", "cccc", "dddd"], 10);
  assert.deepEqual(batches, [["aaaa", "bbbb"], ["cccc", "dddd"]]);
  assert.deepEqual(packBatches(["x".repeat(50), "y"], 10), [["x".repeat(50)], ["y"]]);
  assert.deepEqual(packBatches([], 10), []);
});

// Regression: on staging a 6-part PDF died at the merge step with "did not
// converge". Real partial summaries are ~1000-3000 chars of Persian, and the
// usual batch size (~1900 chars) could not hold two of them, so nothing shrank.
// (The other fakes in this file use tiny partials, which hid it.)
function bigPartialsLlm(partialChars, mergedChars = 900) {
  const seen = { mapChunk: 0, combine: [] };
  const tokens = (s) => Math.ceil(s.length / CHARS_PER_TOKEN);
  return {
    promptChars: PROMPT_CHARS,
    maxOut: MAX_OUT,
    seen,
    async single(text) {
      return { text: "SINGLE", totalTokens: tokens(text) + 700 };
    },
    async mapChunk(chunk) {
      seen.mapChunk += 1;
      return { text: "- نکته ".repeat(Math.ceil(partialChars / 7)).slice(0, partialChars), totalTokens: tokens(chunk) + 800 };
    },
    async combine(partials, { final }) {
      const joined = partials.join("\n\n");
      seen.combine.push({ partials, final, chars: joined.length });
      return {
        text: final ? "FINAL SUMMARY" : "- خلاصه ".repeat(Math.ceil(mergedChars / 8)).slice(0, mergedChars),
        totalTokens: tokens(joined) + 800,
      };
    },
  };
}

test("6 chunks whose partial summaries are longer than half a batch still converge", async () => {
  const llm = bigPartialsLlm(2300);
  const h = harness(llm);
  assert.ok(2300 * 2 > h.budget.batchChars, "premise: two partials do not fit the usual batch");

  const result = await h.run(longText(9000));
  assert.equal(result.text, "FINAL SUMMARY");
  assert.ok(llm.seen.mapChunk >= 4);
  assert.equal(llm.seen.combine.at(-1).final, true);

  // Every merge request stayed under the hard ceiling and the limiter cap.
  for (const c of llm.seen.combine) {
    assert.ok(c.chars <= h.budget.hardBatchChars, `merge input ${c.chars} > ceiling ${h.budget.hardBatchChars}`);
    const est = Math.ceil(c.chars / CHARS_PER_TOKEN) + Math.ceil(PROMPT_CHARS.combine / CHARS_PER_TOKEN) + MAX_OUT.final;
    assert.ok(est <= h.limiter.cap, `merge request ~${est} tokens exceeds cap ${h.limiter.cap}`);
  }
  assert.ok(h.peak() <= h.limiter.cap, "pacing still holds");
});

test("partials too big to pair are condensed one by one, then merged", async () => {
  const llm = bigPartialsLlm(3000, 1200); // 3000 > half of the hard ceiling
  const h = harness(llm);
  assert.ok(3000 * 2 + 2 > h.budget.hardBatchChars, "premise: not even two fit the hard ceiling");

  const result = await h.run(longText(9000));
  assert.equal(result.text, "FINAL SUMMARY");
  const singles = llm.seen.combine.filter((c) => c.partials.length === 1 && !c.final);
  assert.ok(singles.length >= 4, "each oversized partial was condensed alone first");
  assert.equal(llm.seen.combine.at(-1).final, true);
});

test("a big document (many chunks, big partials) still finishes with one final merge", async () => {
  const llm = bigPartialsLlm(2000);
  const h = harness(llm);
  const result = await h.run(longText(40000));
  assert.equal(result.text, "FINAL SUMMARY");
  assert.equal(llm.seen.combine.filter((c) => c.final).length, 1);
  assert.ok(h.peak() <= h.limiter.cap);
});

test("the error, if it ever does happen, says why (sizes and limit)", async () => {
  const llm = fakeLlm({
    async mapChunk() {
      return { text: "x".repeat(5000), totalTokens: 1500 };
    },
    async combine() {
      return { text: "x".repeat(5000), totalTokens: 1500 };
    },
  });
  const h = harness(llm);
  await assert.rejects(() => h.run(longText(9000)), /did not converge \(\d+ partial summaries of 5000,/);
});

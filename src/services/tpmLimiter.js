// Sliding-window limiter for a tokens-per-minute budget. acquire(tokens) waits
// until `tokens` more would still fit under the cap for the trailing minute,
// records them, and returns an entry; settle(entry, actual) then swaps the
// estimate for the real usage Groq reported, so the window tracks reality.
//
// Only requests made through this limiter are counted. The rest of the bot
// (voice summaries, translations) shares the same Groq quota; if those push
// the real total over, Groq answers 429 and the caller backs off (see
// longSummarize.js) — this just keeps the summarizer from causing that itself.

function createTpmLimiter({
  limit,
  windowMs = 60 * 1000,
  headroom = 0.9,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const cap = Math.floor(limit * headroom);
  const entries = []; // { t, tokens }, oldest first

  function prune(t) {
    while (entries.length && entries[0].t <= t - windowMs) entries.shift();
  }

  function used() {
    return entries.reduce((sum, e) => sum + e.tokens, 0);
  }

  async function acquire(tokens) {
    for (;;) {
      const t = now();
      prune(t);
      // A request bigger than the whole cap can never fit; let it through once
      // the window is empty rather than waiting forever.
      if (entries.length === 0 || used() + tokens <= cap) {
        const entry = { t, tokens };
        entries.push(entry);
        return entry;
      }
      await sleep(Math.max(50, entries[0].t + windowMs - t + 50));
    }
  }

  function settle(entry, actualTokens) {
    if (Number.isFinite(actualTokens) && actualTokens > 0) entry.tokens = actualTokens;
  }

  return {
    cap,
    acquire,
    settle,
    used() {
      prune(now());
      return used();
    },
  };
}

module.exports = { createTpmLimiter };

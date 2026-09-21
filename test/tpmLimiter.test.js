const test = require("node:test");
const assert = require("node:assert/strict");

const { createTpmLimiter } = require("../src/services/tpmLimiter");
const { createClock } = require("./helpers");

function virtualLimiter(limit = 6000, headroom = 0.9) {
  const clock = createClock(0);
  const sleeps = [];
  const limiter = createTpmLimiter({
    limit,
    headroom,
    now: clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  });
  return { limiter, clock, sleeps };
}

test("requests that fit under the cap go through immediately", async () => {
  const { limiter, sleeps } = virtualLimiter();
  await limiter.acquire(2500);
  await limiter.acquire(2500);
  assert.equal(sleeps.length, 0);
  assert.equal(limiter.used(), 5000);
});

test("a request that would exceed the cap waits until enough of the window has aged out", async () => {
  const { limiter, clock, sleeps } = virtualLimiter(); // cap = 5400
  await limiter.acquire(2800);
  clock.advance(10 * 1000);
  await limiter.acquire(2500); // 5300 <= 5400: ok
  assert.equal(sleeps.length, 0);

  const before = clock();
  await limiter.acquire(2800); // needs the first entry (t=0) to expire
  assert.equal(sleeps.length, 1);
  assert.ok(clock() - before >= 60 * 1000 - 10 * 1000, "waited for the oldest entry to age out");
  assert.ok(limiter.used() <= limiter.cap);
});

test("settle replaces the estimate with real usage, freeing room when the estimate was high", async () => {
  const { limiter, sleeps } = virtualLimiter();
  const first = await limiter.acquire(2850);
  limiter.settle(first, 1900); // the call actually used less
  await limiter.acquire(2850); // 1900 + 2850 = 4750 <= 5400: no wait
  assert.equal(sleeps.length, 0);
});

test("over any trailing minute the recorded total never exceeds the cap", async () => {
  const { limiter, clock } = virtualLimiter();
  const log = [];
  for (let i = 0; i < 30; i++) {
    const entry = await limiter.acquire(2600);
    limiter.settle(entry, 2400);
    log.push({ t: clock(), tokens: 2400 });
    const inWindow = log.filter((e) => e.t > clock() - 60 * 1000).reduce((s, e) => s + e.tokens, 0);
    assert.ok(inWindow <= limiter.cap, `window total ${inWindow} exceeded cap ${limiter.cap}`);
  }
});

test("a single request larger than the whole cap still gets through once the window is empty", async () => {
  const { limiter } = virtualLimiter(1000);
  await limiter.acquire(5000); // would otherwise wait forever
  assert.equal(limiter.used(), 5000);
});

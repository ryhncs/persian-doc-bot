const test = require("node:test");
const assert = require("node:assert/strict");

const { createUsageService } = require("../src/services/usage");
const { createFakeStore, createClock, silentLog } = require("./helpers");

const DAY = 24 * 60 * 60 * 1000;

function setup(overrides = {}) {
  const store = createFakeStore(overrides.storeOptions);
  const clock = createClock();
  const usage = createUsageService({
    store: overrides.noStore ? null : store,
    limit: 3,
    now: clock,
    log: silentLog,
  });
  return { store, clock, usage };
}

test("monetization disabled (no store): everything is allowed and nothing is counted", async () => {
  const { usage } = setup({ noStore: true });
  const gate = await usage.checkAndConsume(1);
  assert.deepEqual(gate, { allowed: true, counted: false, disabled: true });
  assert.equal(usage.enabled, false);
});

test("allows exactly `limit` requests per window, then blocks with a reset time", async () => {
  const { usage, clock } = setup();
  const startedAt = clock();

  for (let i = 1; i <= 3; i++) {
    const gate = await usage.checkAndConsume(42);
    assert.equal(gate.allowed, true);
    assert.equal(gate.counted, true);
    assert.equal(gate.used, i);
  }

  const blocked = await usage.checkAndConsume(42);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.limit, 3);
  assert.equal(blocked.resetAt, startedAt + 7 * DAY);
});

test("counter resets once week_reset_at has passed, starting a new 7-day window", async () => {
  const { usage, clock, store } = setup();
  for (let i = 0; i < 3; i++) await usage.checkAndConsume(42);
  assert.equal((await usage.checkAndConsume(42)).allowed, false);

  clock.advance(7 * DAY + 1000);

  const gate = await usage.checkAndConsume(42);
  assert.equal(gate.allowed, true);
  assert.equal(gate.used, 1);
  assert.equal(store.rows.get(42).weekly_request_count, 1);
  assert.equal(Date.parse(store.rows.get(42).week_reset_at), clock() + 7 * DAY);
});

test("does not reset early: still blocked just before the window ends", async () => {
  const { usage, clock } = setup();
  for (let i = 0; i < 3; i++) await usage.checkAndConsume(42);
  clock.advance(7 * DAY - 1000);
  assert.equal((await usage.checkAndConsume(42)).allowed, false);
});

test("users are counted independently", async () => {
  const { usage } = setup();
  for (let i = 0; i < 3; i++) await usage.checkAndConsume(1);
  assert.equal((await usage.checkAndConsume(1)).allowed, false);
  assert.equal((await usage.checkAndConsume(2)).allowed, true);
});

test("active subscription is unlimited and does not touch the counter", async () => {
  const { usage, store } = setup();
  await usage.activateSubscription(42, 30);

  for (let i = 0; i < 10; i++) {
    const gate = await usage.checkAndConsume(42);
    assert.equal(gate.allowed, true);
    assert.equal(gate.subscribed, true);
    assert.equal(gate.counted, false);
  }
  assert.equal(store.rows.get(42).weekly_request_count, 0);
});

test("an expired subscription falls back to the weekly limit", async () => {
  const { usage, clock } = setup();
  await usage.activateSubscription(42, 30);
  clock.advance(30 * DAY + 1000);

  for (let i = 0; i < 3; i++) assert.equal((await usage.checkAndConsume(42)).allowed, true);
  assert.equal((await usage.checkAndConsume(42)).allowed, false);
});

test("subscription expiry is exactly now + 30 days and clears the pending flag", async () => {
  const { usage, clock, store } = setup();
  await usage.markPaymentPending(42);
  assert.notEqual(store.rows.get(42).payment_pending_at, null);

  const expiresAt = await usage.activateSubscription(42, 30);
  assert.equal(expiresAt, clock() + 30 * DAY);
  assert.equal(Date.parse(store.rows.get(42).subscription_expires_at), expiresAt);
  assert.equal(store.rows.get(42).payment_pending_at, null);
});

test("concurrent requests from one user can never exceed the limit", async () => {
  const { usage, store } = setup();
  const results = await Promise.all(Array.from({ length: 12 }, () => usage.checkAndConsume(42)));

  assert.equal(results.filter((r) => r.allowed).length, 3);
  assert.equal(results.filter((r) => !r.allowed).length, 9);
  assert.equal(results.filter((r) => r.degraded).length, 0);
  assert.equal(store.rows.get(42).weekly_request_count, 3);
});

test("refund gives back a counted request, but only once and never below zero", async () => {
  const { usage, store } = setup();
  const gate = await usage.checkAndConsume(42);
  assert.equal(store.rows.get(42).weekly_request_count, 1);

  await usage.refund(42, gate);
  assert.equal(store.rows.get(42).weekly_request_count, 0);

  await usage.refund(42, { allowed: true, counted: false }); // uncounted: no-op
  await usage.refund(42, gate); // count already 0: no-op
  assert.equal(store.rows.get(42).weekly_request_count, 0);
});

test("refund is a no-op once the window has rolled over", async () => {
  const { usage, clock, store } = setup();
  const gate = await usage.checkAndConsume(42);
  clock.advance(8 * DAY);
  await usage.refund(42, gate);
  assert.equal(store.rows.get(42).weekly_request_count, 1);
});

test("a refunded request frees the slot for another request", async () => {
  const { usage } = setup();
  const gates = [];
  for (let i = 0; i < 3; i++) gates.push(await usage.checkAndConsume(42));
  assert.equal((await usage.checkAndConsume(42)).allowed, false);

  await usage.refund(42, gates[2]);
  assert.equal((await usage.checkAndConsume(42)).allowed, true);
});

test("fails open when the database is unreachable", async () => {
  const { usage } = setup({ storeOptions: { failWith: new Error("connection refused") } });
  const gate = await usage.checkAndConsume(42);
  assert.equal(gate.allowed, true);
  assert.equal(gate.counted, false);
  assert.equal(gate.degraded, true);
});

test("payment state: pending within the TTL, not after it, never while subscribed", async () => {
  const { usage, clock } = setup();
  assert.deepEqual(await usage.getPaymentState(42), { pending: false, subscribed: false });

  await usage.markPaymentPending(42);
  assert.deepEqual(await usage.getPaymentState(42), { pending: true, subscribed: false });

  clock.advance(23 * 60 * 60 * 1000);
  assert.equal((await usage.getPaymentState(42)).pending, true);

  clock.advance(2 * 60 * 60 * 1000);
  assert.equal((await usage.getPaymentState(42)).pending, false);

  await usage.markPaymentPending(42);
  await usage.activateSubscription(42, 30);
  assert.deepEqual(await usage.getPaymentState(42), { pending: false, subscribed: true });
});

test("rejectPayment keeps the user pending so a corrected receipt still reaches the admin", async () => {
  const { usage, clock } = setup();
  await usage.markPaymentPending(42);
  clock.advance(20 * 60 * 60 * 1000);
  await usage.rejectPayment(42);
  clock.advance(20 * 60 * 60 * 1000); // 40h after the paywall, 20h after the rejection
  assert.equal((await usage.getPaymentState(42)).pending, true);
});

test("a limit of 0 blocks everyone without a subscription", async () => {
  const store = createFakeStore();
  const clock = createClock();
  const usage = createUsageService({ store, limit: 0, now: clock, log: silentLog });
  assert.equal((await usage.checkAndConsume(42)).allowed, false);
  clock.advance(8 * DAY);
  assert.equal((await usage.checkAndConsume(42)).allowed, false);
});

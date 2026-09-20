const test = require("node:test");
const assert = require("node:assert/strict");

const { createUsageService } = require("../src/services/usage");
const { CODE_ALPHABET } = require("../src/services/referrals");
const { createFakeStore, createClock, silentLog } = require("./helpers");

const DAY = 24 * 60 * 60 * 1000;

function setup({ storeOptions, referral, generate } = {}) {
  const store = createFakeStore(storeOptions);
  const clock = createClock();
  const usage = createUsageService({
    store,
    limit: 3,
    now: clock,
    log: silentLog,
    referral: { bonusRequests: 2, bonusCap: 10, perCoupon: 3, ...referral },
  });
  return { store, clock, usage, referrals: usage.referrals };
}

// A user (`id`) who arrives through `code` and gets one request delivered.
async function invitedUserCompletesARequest(ctx, code, id) {
  const attributed = await ctx.referrals.attribute(id, code);
  assert.equal(attributed.ok, true, `attribution of ${id}: ${attributed.reason}`);
  const gate = await ctx.usage.checkAndConsume(id);
  assert.equal(gate.allowed, true);
  return ctx.referrals.confirmDelivered(id);
}

async function codeFor(ctx, id) {
  return (await ctx.referrals.getInfo(id)).code;
}

// --- codes -------------------------------------------------------------------
test("a user gets one stable code, made of unambiguous characters", async () => {
  const ctx = setup();
  const first = await ctx.referrals.getInfo(1);
  assert.match(first.code, new RegExp(`^[${CODE_ALPHABET}]{8}$`));
  assert.equal((await ctx.referrals.getInfo(1)).code, first.code);
  assert.equal(ctx.store.rows.get(1).referral_code, first.code);
});

test("different users get different codes, and a code collision is retried", async () => {
  const codes = ["SAMECODE", "SAMECODE", "OTHERONE"];
  const ctx = setup({ generate: null });
  // A service whose generator first repeats an existing code.
  const { createReferralService } = require("../src/services/referrals");
  const referrals = createReferralService({ store: ctx.store, generate: () => codes.shift(), log: silentLog, now: ctx.clock });
  const a = await referrals.getInfo(1);
  const b = await referrals.getInfo(2);
  assert.equal(a.code, "SAMECODE");
  assert.equal(b.code, "OTHERONE", "second user skipped the taken code");
});

// --- attribution ---------------------------------------------------------------
test("a link records who invited a new user, but pays nothing yet", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);

  assert.deepEqual(await ctx.referrals.attribute(2, code), { ok: true, inviterId: 1 });

  assert.equal(ctx.store.rows.get(2).referred_by, 1);
  assert.equal(ctx.store.rows.get(2).bonus_requests, 0, "clicking the link pays nothing");
  assert.equal(ctx.store.rows.get(1).bonus_requests, 0);
  assert.equal(ctx.store.rows.get(1).successful_referrals, 0);
});

test("a referred new user still gets a full fresh 7-day free window on their first request", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  await ctx.referrals.attribute(2, code);
  ctx.clock.advance(3 * DAY); // they wait a few days before their first request

  for (let i = 0; i < 3; i++) assert.equal((await ctx.usage.checkAndConsume(2)).allowed, true);
  assert.equal((await ctx.usage.checkAndConsume(2)).allowed, false);
  const resetAt = Date.parse(ctx.store.rows.get(2).week_reset_at);
  assert.equal(resetAt, ctx.clock() + 7 * DAY, "window started at the first request, not at /start");
});

test("codes are case-insensitive, unknown codes and yourself are refused", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  assert.equal((await ctx.referrals.attribute(2, code.toLowerCase())).ok, true);
  assert.deepEqual(await ctx.referrals.attribute(3, "NOSUCHCD"), { ok: false, reason: "unknown_code" });
  assert.deepEqual(await ctx.referrals.attribute(1, code), { ok: false, reason: "self" });
  assert.equal(ctx.store.rows.get(1).referred_by, null);
});

test("only a new user can be attributed: not after a delivered request, not twice, not to someone else", async () => {
  const ctx = setup();
  const codeA = await codeFor(ctx, 1);
  const codeC = await codeFor(ctx, 3);

  // User 2 already used the bot before following any link.
  await ctx.usage.checkAndConsume(2);
  await ctx.referrals.confirmDelivered(2);
  assert.deepEqual(await ctx.referrals.attribute(2, codeA), { ok: false, reason: "not_new" });
  assert.equal(ctx.store.rows.get(2).referred_by, null);

  // User 4 is attributed once; a second, different link does not override it.
  assert.equal((await ctx.referrals.attribute(4, codeA)).ok, true);
  assert.deepEqual(await ctx.referrals.attribute(4, codeC), { ok: false, reason: "already_referred" });
  assert.equal(ctx.store.rows.get(4).referred_by, 1);
});

test("a user whose request failed (never delivered) is still new and can be attributed", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  const gate = await ctx.usage.checkAndConsume(2);
  await ctx.usage.refund(2, gate); // the request failed, nothing was delivered
  assert.equal((await ctx.referrals.attribute(2, code)).ok, true);
});

test("two invitations cannot loop back: the inviter (already active) can't be referred by their own invitee", async () => {
  const ctx = setup();
  const codeA = await codeFor(ctx, 1);
  await invitedUserCompletesARequest(ctx, codeA, 2);
  await ctx.usage.checkAndConsume(1);
  await ctx.referrals.confirmDelivered(1);
  const codeB = await codeFor(ctx, 2);
  assert.equal((await ctx.referrals.attribute(1, codeB)).ok, false);
});

// --- the bonus -----------------------------------------------------------------
test("the bonus is paid when the invitee's first request is delivered: +2 to both", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);

  const result = await invitedUserCompletesARequest(ctx, code, 2);

  assert.equal(result.inviteeId, 2);
  assert.equal(result.inviteeBonus, 2);
  assert.equal(result.referrerId, 1);
  assert.equal(result.referrer.bonusGranted, true);
  assert.equal(ctx.store.rows.get(2).bonus_requests, 2);
  assert.equal(ctx.store.rows.get(1).bonus_requests, 2);
  assert.equal(ctx.store.rows.get(1).successful_referrals, 1);
  assert.equal(ctx.store.rows.get(1).referral_progress, 1);
  assert.ok(ctx.store.rows.get(2).referral_qualified_at);
  assert.ok(ctx.store.rows.get(2).first_action_at);
});

test("the bonus is paid once, however many requests follow and even if they race", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  await ctx.referrals.attribute(2, code);
  await ctx.usage.checkAndConsume(2);

  const results = await Promise.all(Array.from({ length: 6 }, () => ctx.referrals.confirmDelivered(2)));
  assert.equal(results.filter(Boolean).length, 1, "exactly one confirmation paid out");
  await ctx.referrals.confirmDelivered(2);

  assert.equal(ctx.store.rows.get(1).bonus_requests, 2);
  assert.equal(ctx.store.rows.get(1).successful_referrals, 1);
  assert.equal(ctx.store.rows.get(2).bonus_requests, 2);
});

test("a user who wasn't invited just becomes active: no payout, and can't be referred later", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  await ctx.usage.checkAndConsume(2);
  assert.equal(await ctx.referrals.confirmDelivered(2), null);
  assert.ok(ctx.store.rows.get(2).first_action_at);
  assert.equal(ctx.store.rows.get(2).bonus_requests, 0);
  assert.equal((await ctx.referrals.attribute(2, code)).reason, "not_new");
  assert.equal(ctx.store.rows.get(1).bonus_requests, 0);
});

test("without confirmDelivered (link clicked, request failed or refunded) nobody is paid", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  await ctx.referrals.attribute(2, code);
  const gate = await ctx.usage.checkAndConsume(2);
  await ctx.usage.refund(2, gate);
  assert.equal(ctx.store.rows.get(2).bonus_requests, 0);
  assert.equal(ctx.store.rows.get(1).bonus_requests, 0);
  assert.equal(ctx.store.rows.get(1).successful_referrals, 0);
});

test("referral counting survives many invitees confirming at the same time", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  const ids = [11, 12, 13, 14, 15];
  for (const id of ids) {
    await ctx.referrals.attribute(id, code);
    await ctx.usage.checkAndConsume(id);
  }
  await Promise.all(ids.map((id) => ctx.referrals.confirmDelivered(id)));
  const row = ctx.store.rows.get(1);
  assert.equal(row.successful_referrals, 5);
  assert.equal(row.bonus_requests, 10);
  assert.equal(row.coupons_available, 1);
  assert.equal(row.referral_progress, 5);
});

// --- the cap ---------------------------------------------------------------------
test("the +2 bonus stops after 10 successful referrals; coupons keep counting; invitees still get theirs", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  let last;
  for (let id = 100; id < 112; id++) last = await invitedUserCompletesARequest(ctx, code, id);

  const row = ctx.store.rows.get(1);
  assert.equal(row.successful_referrals, 12);
  assert.equal(row.bonus_requests, 20, "only the first 10 referrals paid +2");
  assert.equal(row.coupons_available, 4, "12 referrals = 4 coupons");
  assert.equal(last.referrer.bonusGranted, false);
  assert.equal(ctx.store.rows.get(111).bonus_requests, 2, "the 12th invitee still got their bonus");
  assert.equal((await ctx.referrals.getInfo(1)).bonusCapReached, true);
});

// --- coupons -----------------------------------------------------------------------
test("every 3 successful referrals earn a coupon, and coupons bank up", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  const earned = [];
  for (let id = 200; id < 207; id++) {
    const r = await invitedUserCompletesARequest(ctx, code, id);
    earned.push(r.referrer.couponEarned);
  }
  assert.deepEqual(earned, [false, false, true, false, false, true, false]);
  const info = await ctx.referrals.getInfo(1);
  assert.equal(info.coupons, 2, "two unused coupons banked");
  assert.equal(info.successful, 7);
  assert.equal(info.untilNextCoupon, 2, "1 of 3 toward the next");
});

test("redeeming uses exactly one coupon and resets the referral count to 0", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  for (let id = 300; id < 307; id++) await invitedUserCompletesARequest(ctx, code, id); // 2 coupons, 1 toward next

  assert.equal(await ctx.referrals.redeemCoupon(1), true);
  let row = ctx.store.rows.get(1);
  assert.equal(row.coupons_available, 1);
  assert.equal(row.coupons_redeemed, 1);
  assert.equal(row.referral_progress, 0, "count reset");
  assert.equal((await ctx.referrals.getInfo(1)).untilNextCoupon, 3, "needs 3 more referrals");

  await invitedUserCompletesARequest(ctx, code, 310);
  await invitedUserCompletesARequest(ctx, code, 311);
  assert.equal(ctx.store.rows.get(1).coupons_available, 1, "2 more referrals: no new coupon yet");
  await invitedUserCompletesARequest(ctx, code, 312);
  assert.equal(ctx.store.rows.get(1).coupons_available, 2, "the 3rd earns the next one");

  assert.equal(await ctx.referrals.redeemCoupon(1), true);
  assert.equal(await ctx.referrals.redeemCoupon(1), true);
  assert.equal(await ctx.referrals.redeemCoupon(1), false, "none left");
  row = ctx.store.rows.get(1);
  assert.equal(row.coupons_available, 0);
  assert.equal(row.coupons_redeemed, 3);
});

test("two concurrent redemptions of a single coupon succeed only once", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  for (let id = 400; id < 403; id++) await invitedUserCompletesARequest(ctx, code, id);
  const results = await Promise.all([ctx.referrals.redeemCoupon(1), ctx.referrals.redeemCoupon(1), ctx.referrals.redeemCoupon(1)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(ctx.store.rows.get(1).coupons_available, 0);
  assert.equal(ctx.store.rows.get(1).coupons_redeemed, 1);
});

test("coupons never expire: they are still there a year later", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  for (let id = 500; id < 503; id++) await invitedUserCompletesARequest(ctx, code, id);
  ctx.clock.advance(365 * DAY);
  assert.equal((await ctx.usage.getPaymentState(1)).coupons, 1);
  assert.equal(await ctx.referrals.redeemCoupon(1), true);
});

// --- bonus requests are spent after the weekly allowance -----------------------------------
test("bonus requests are used only after the weekly allowance, and survive a weekly reset", async () => {
  const ctx = setup();
  ctx.store.rows.set(9, {
    telegram_user_id: 9,
    weekly_request_count: 0,
    week_reset_at: new Date(ctx.clock() + 7 * DAY).toISOString(),
    subscription_expires_at: null,
    payment_pending_at: null,
    bonus_requests: 2,
  });

  const sources = [];
  for (let i = 0; i < 5; i++) {
    const gate = await ctx.usage.checkAndConsume(9);
    sources.push(gate.allowed ? gate.source : "denied");
  }
  assert.deepEqual(sources, ["weekly", "weekly", "weekly", "bonus", "bonus"]);
  assert.equal((await ctx.usage.checkAndConsume(9)).allowed, false, "3 weekly + 2 bonus, then the paywall");
  assert.equal(ctx.store.rows.get(9).bonus_requests, 0);

  // A fresh week restores the weekly allowance; unused bonus would be kept.
  ctx.store.rows.get(9).bonus_requests = 1;
  ctx.clock.advance(7 * DAY + 1000);
  const sources2 = [];
  for (let i = 0; i < 4; i++) {
    const gate = await ctx.usage.checkAndConsume(9);
    sources2.push(gate.allowed ? gate.source : "denied");
  }
  assert.deepEqual(sources2, ["weekly", "weekly", "weekly", "bonus"]);
});

test("a refunded bonus request gives the bonus back, not a weekly request", async () => {
  const ctx = setup();
  const code = await codeFor(ctx, 1);
  await invitedUserCompletesARequest(ctx, code, 2); // inviter 1 now has +2 bonus
  for (let i = 0; i < 3; i++) await ctx.usage.checkAndConsume(1);

  const gate = await ctx.usage.checkAndConsume(1);
  assert.equal(gate.source, "bonus");
  assert.equal(ctx.store.rows.get(1).bonus_requests, 1);
  await ctx.usage.refund(1, gate);
  assert.equal(ctx.store.rows.get(1).bonus_requests, 2);
  assert.equal(ctx.store.rows.get(1).weekly_request_count, 3, "weekly count untouched");
  await ctx.usage.refund(1, { counted: false }); // an uncounted gate refunds nothing
  assert.equal(ctx.store.rows.get(1).bonus_requests, 2);
});

test("concurrent requests can never spend more bonus than the user has", async () => {
  const ctx = setup();
  ctx.store.rows.set(9, {
    telegram_user_id: 9,
    weekly_request_count: 3,
    week_reset_at: new Date(ctx.clock() + 7 * DAY).toISOString(),
    subscription_expires_at: null,
    payment_pending_at: null,
    bonus_requests: 2,
  });
  const gates = await Promise.all(Array.from({ length: 8 }, () => ctx.usage.checkAndConsume(9)));
  assert.equal(gates.filter((g) => g.allowed).length, 2);
  assert.equal(ctx.store.rows.get(9).bonus_requests, 0);
});

test("with 0 free requests a week, bonus requests still work", async () => {
  const store = createFakeStore();
  const clock = createClock();
  const usage = createUsageService({ store, limit: 0, now: clock, log: silentLog });
  store.rows.set(9, { telegram_user_id: 9, weekly_request_count: 0, week_reset_at: new Date(clock() - 1000).toISOString(), bonus_requests: 1 });
  assert.equal((await usage.checkAndConsume(9)).source, "bonus");
  assert.equal((await usage.checkAndConsume(9)).allowed, false);
});

// --- fail open -------------------------------------------------------------------------------
test("when the database is down, referral calls never throw and the bot keeps working", async () => {
  const ctx = setup({ storeOptions: { failWith: new Error("PGRST125") } });
  assert.deepEqual(await ctx.referrals.attribute(2, "ABCD2345"), { ok: false, reason: "error" });
  assert.equal(await ctx.referrals.confirmDelivered(2), null);
  assert.equal(await ctx.referrals.getInfo(1), null);
  assert.equal(await ctx.referrals.redeemCoupon(1), false);
  assert.equal((await ctx.usage.checkAndConsume(1)).allowed, true, "core requests still allowed");
});

test("with no store at all (monetization off) referrals are inert", async () => {
  const usage = createUsageService({ store: null, limit: 3, log: silentLog });
  assert.equal(usage.referrals.enabled, false);
  assert.equal(await usage.referrals.getInfo(1), null);
  assert.equal(await usage.referrals.confirmDelivered(1), null);
  assert.deepEqual(await usage.referrals.attribute(1, "ABCD2345"), { ok: false, reason: "disabled" });
});

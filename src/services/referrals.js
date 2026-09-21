// Referral bookkeeping on top of the same `store` as usage.js (see
// supabaseStore.js and supabase/schema.sql).
//
//   - Every user can have a referral code (created on first /invite).
//   - "/start ref_<code>" from a NEW user (no delivered billable request yet)
//     records who invited them (`referred_by`).
//   - The bonus is paid only when the invitee's first billable request has
//     actually been delivered (confirmDelivered): both sides get
//     `bonusRequests` extra requests. Clicking the link or pressing Start pays
//     nothing, and a request that fails (and is refunded) doesn't count.
//   - The referrer's first `bonusCap` successful referrals earn the bonus;
//     coupons keep counting after that. Whenever a user's running total of
//     successful referrals reaches a new multiple of `perCoupon` they earn one
//     discount coupon; coupons bank up and never expire. Progress toward the
//     next coupon is always that total modulo `perCoupon`: redeeming a coupon
//     (redeemCoupon) only lowers the coupon balance and never touches the
//     total, so it is independent of how many coupons were already redeemed.
//
// Fails OPEN like the rest of monetization: nothing here throws. If the
// database is unreachable the bot keeps working and referrals just aren't
// tracked during the outage.
//
// Each step is a compare-and-set (store.tryUpdate), so two concurrent requests
// can't both pay the same bonus. The invitee's row is claimed first and the
// referrer credited second; a crash between the two would lose the referrer's
// credit (never double-pay it).

const crypto = require("crypto");

// No 0/O/1/I/L so a code read aloud or retyped isn't ambiguous.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function createReferralService({
  store,
  bonusRequests = 2,
  bonusCap = 10,
  perCoupon = 3,
  generate = generateCode, // injectable for tests
  now = () => Date.now(),
  log = console,
}) {
  const enabled = Boolean(store);
  const iso = (ms) => new Date(ms).toISOString();
  const num = (v) => Number(v) || 0;
  const MAX_ATTEMPTS = 6;
  // Users already known to have a delivered request: skips the database on
  // every later success.
  const activeUsers = new Set();

  /**
   * Records that `inviteeId` arrived through `code`. Only accepted for users who
   * haven't had a delivered request yet, never for yourself, and only once.
   * Resolves { ok: true, inviterId } or { ok: false, reason }.
   */
  async function attribute(inviteeId, code) {
    if (!enabled) return { ok: false, reason: "disabled" };
    try {
      const inviter = await store.getUserByReferralCode(String(code).toUpperCase());
      if (!inviter) return { ok: false, reason: "unknown_code" };
      const inviterId = Number(inviter.telegram_user_id);
      if (inviterId === inviteeId) return { ok: false, reason: "self" };

      let row = await store.getUser(inviteeId);
      if (!row) {
        // Window starts "expired", so the first request opens a fresh 7 days.
        row = await store.createUser({
          telegram_user_id: inviteeId,
          weekly_request_count: 0,
          week_reset_at: iso(now()),
          referred_by: inviterId,
        });
        if (row) return { ok: true, inviterId };
        row = await store.getUser(inviteeId); // lost a race with another insert
        if (!row) return { ok: false, reason: "error" };
      }

      if (row.referred_by) return { ok: false, reason: "already_referred" };
      if (row.first_action_at) return { ok: false, reason: "not_new" };

      const updated = await store.tryUpdate(inviteeId, { first_action_at: null, referred_by: null }, { referred_by: inviterId });
      return updated ? { ok: true, inviterId } : { ok: false, reason: "not_new" };
    } catch (err) {
      log.error(`[referrals] could not record referral for user ${inviteeId}:`, err && err.message);
      return { ok: false, reason: "error" };
    }
  }

  async function creditReferrer(referrerId) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await store.getUser(referrerId);
      if (!r) return null;
      const successful = num(r.successful_referrals);
      const coupons = num(r.coupons_available);
      const bonus = num(r.bonus_requests);

      const bonusGranted = successful < bonusCap;
      // The running total just crossed a new multiple of perCoupon.
      const couponEarned = (successful + 1) % perCoupon === 0;
      const row = await store.tryUpdate(
        referrerId,
        { successful_referrals: successful, coupons_available: coupons, bonus_requests: bonus },
        {
          successful_referrals: successful + 1,
          coupons_available: coupons + (couponEarned ? 1 : 0),
          bonus_requests: bonus + (bonusGranted ? bonusRequests : 0),
        }
      );
      if (row) {
        return {
          id: referrerId,
          bonusGranted,
          bonus: bonusRequests,
          successful: successful + 1,
          progress: (successful + 1) % perCoupon,
          couponEarned,
          coupons: coupons + (couponEarned ? 1 : 0),
        };
      }
    }
    log.warn(`[referrals] gave up crediting referrer ${referrerId} after ${MAX_ATTEMPTS} contended attempts`);
    return null;
  }

  /**
   * Call after a billable request was actually delivered to `userId`. The first
   * time, marks the user as active and, if they were invited, pays the bonus to
   * both sides. Resolves null when there is nothing to announce, else
   * { inviteeId, inviteeBonus, referrerId, referrer } (referrer is null if the
   * referrer could not be credited).
   */
  async function confirmDelivered(userId) {
    if (!enabled || activeUsers.has(userId)) return null;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const user = await store.getUser(userId);
        if (!user) return null;
        if (user.first_action_at) {
          activeUsers.add(userId);
          return null;
        }

        const referrerId = user.referred_by ? Number(user.referred_by) : null;
        const t = iso(now());
        const bonus = num(user.bonus_requests);
        const expected = { first_action_at: null, referred_by: referrerId };
        const fields = { first_action_at: t };
        if (referrerId) {
          expected.bonus_requests = bonus;
          fields.referral_qualified_at = t;
          fields.bonus_requests = bonus + bonusRequests;
        }

        const won = await store.tryUpdate(userId, expected, fields);
        if (!won) continue; // changed under us; look again
        activeUsers.add(userId);
        if (!referrerId) return null;

        const referrer = await creditReferrer(referrerId);
        return { inviteeId: userId, inviteeBonus: bonusRequests, referrerId, referrer };
      }
      log.warn(`[referrals] gave up marking user ${userId} active after ${MAX_ATTEMPTS} contended attempts`);
      return null;
    } catch (err) {
      log.error(`[referrals] confirmDelivered failed for user ${userId}:`, err && err.message);
      return null;
    }
  }

  function summarize(user) {
    const successful = num(user.successful_referrals);
    return {
      code: user.referral_code,
      successful,
      progressToNext: successful % perCoupon,
      untilNextCoupon: perCoupon - (successful % perCoupon),
      coupons: num(user.coupons_available),
      couponsRedeemed: num(user.coupons_redeemed),
      bonusRequests: num(user.bonus_requests),
      bonusCapReached: successful >= bonusCap,
    };
  }

  /** The user's code (created on first use) and status, or null if unavailable. */
  async function getInfo(userId) {
    if (!enabled) return null;
    try {
      let user = await store.getUser(userId);
      if (!user) {
        user =
          (await store.createUser({ telegram_user_id: userId, weekly_request_count: 0, week_reset_at: iso(now()) })) ||
          (await store.getUser(userId));
      }
      if (!user) return null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS && !user.referral_code; attempt++) {
        try {
          const row = await store.tryUpdate(userId, { referral_code: null }, { referral_code: generate() });
          user = row || (await store.getUser(userId)) || user;
        } catch (err) {
          if (!/\(409\)/.test(err && err.message)) throw err; // a code collision: try another
        }
      }
      return user.referral_code ? summarize(user) : null;
    } catch (err) {
      log.error(`[referrals] could not load referral info for user ${userId}:`, err && err.message);
      return null;
    }
  }

  /** Uses up one coupon; only the coupon balance changes (not the referral total). True if one was redeemed. */
  async function redeemCoupon(userId) {
    if (!enabled) return false;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const user = await store.getUser(userId);
        if (!user || num(user.coupons_available) <= 0) return false;
        const coupons = num(user.coupons_available);
        const redeemed = num(user.coupons_redeemed);
        const row = await store.tryUpdate(
          userId,
          { coupons_available: coupons, coupons_redeemed: redeemed },
          { coupons_available: coupons - 1, coupons_redeemed: redeemed + 1 }
        );
        if (row) return true;
      }
      return false;
    } catch (err) {
      log.error(`[referrals] could not redeem coupon for user ${userId}:`, err && err.message);
      return false;
    }
  }

  return { enabled, attribute, confirmDelivered, getInfo, redeemCoupon, generateCode };
}

module.exports = { createReferralService, generateCode, CODE_ALPHABET };

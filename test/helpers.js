// In-memory stand-in for supabaseStore.js. Every method yields to the event
// loop before touching state, so concurrent callers interleave the way they
// would against a real database; the check-and-write after the yield is
// synchronous, i.e. atomic, like a conditional PATCH.
function createFakeStore({ failWith, pingWarnings = [] } = {}) {
  const rows = new Map();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const guard = async () => {
    await tick();
    if (failWith) throw failWith;
  };
  const copy = (row) => (row ? { ...row } : null);
  const defaults = (id, now) => ({
    telegram_user_id: id,
    weekly_request_count: 0,
    week_reset_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    subscription_expires_at: null,
    payment_pending_at: null,
    first_action_at: null,
    referral_code: null,
    referred_by: null,
    referral_qualified_at: null,
    bonus_requests: 0,
    successful_referrals: 0,
    referral_progress: 0,
    coupons_available: 0,
    coupons_redeemed: 0,
  });

  return {
    rows,
    async ping() {
      await guard();
      return { warnings: pingWarnings };
    },
    async getUser(id) {
      await guard();
      return copy(rows.get(id));
    },
    async createUser(row) {
      await guard();
      if (rows.has(row.telegram_user_id)) return null;
      const created = { ...defaults(row.telegram_user_id, Date.now()), ...row };
      rows.set(row.telegram_user_id, created);
      return copy(created);
    },
    async upsert(id, fields) {
      await guard();
      const next = { ...(rows.get(id) || defaults(id, Date.now())), ...fields };
      rows.set(id, next);
      return copy(next);
    },
    async tryIncrement(id, expectedCount, nowIso) {
      await guard();
      const row = rows.get(id);
      if (!row || row.weekly_request_count !== expectedCount) return null;
      if (!(Date.parse(row.week_reset_at) > Date.parse(nowIso))) return null;
      row.weekly_request_count = expectedCount + 1;
      return copy(row);
    },
    async tryResetWindow(id, nowIso, newResetAtIso) {
      await guard();
      const row = rows.get(id);
      if (!row || !(Date.parse(row.week_reset_at) <= Date.parse(nowIso))) return null;
      row.weekly_request_count = 1;
      row.week_reset_at = newResetAtIso;
      return copy(row);
    },
    async tryUpdate(id, expected, fields) {
      await guard();
      const row = rows.get(id);
      if (!row) return null;
      for (const [column, value] of Object.entries(expected)) {
        const actual = row[column] === undefined ? null : row[column];
        if (actual !== value) return null;
      }
      if (fields.referral_code) {
        for (const other of rows.values()) {
          if (other !== row && other.referral_code === fields.referral_code) {
            throw new Error("Supabase PATCH failed (409): duplicate key");
          }
        }
      }
      Object.assign(row, fields);
      return copy(row);
    },
    async getUserByReferralCode(code) {
      await guard();
      for (const row of rows.values()) if (row.referral_code === code) return copy(row);
      return null;
    },
    async tryDecrement(id, expectedCount, nowIso) {
      await guard();
      const row = rows.get(id);
      if (!row || row.weekly_request_count !== expectedCount) return null;
      if (!(Date.parse(row.week_reset_at) > Date.parse(nowIso))) return null;
      row.weekly_request_count = expectedCount - 1;
      return copy(row);
    },
  };
}

function createClock(startMs = Date.UTC(2026, 8, 20, 12, 0, 0)) {
  let t = startMs;
  const clock = () => t;
  clock.advance = (ms) => {
    t += ms;
  };
  return clock;
}

const silentLog = { warn() {}, error() {}, log() {} };

module.exports = { createFakeStore, createClock, silentLog };

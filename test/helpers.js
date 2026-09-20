// In-memory stand-in for supabaseStore.js. Every method yields to the event
// loop before touching state, so concurrent callers interleave the way they
// would against a real database; the check-and-write after the yield is
// synchronous, i.e. atomic, like a conditional PATCH.
function createFakeStore({ failWith } = {}) {
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
  });

  return {
    rows,
    async getUser(id) {
      await guard();
      return copy(rows.get(id));
    },
    async createUser(row) {
      await guard();
      if (rows.has(row.telegram_user_id)) return null;
      const created = { subscription_expires_at: null, payment_pending_at: null, ...row };
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

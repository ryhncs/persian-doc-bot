// Free-tier limiting + subscription state, on top of a `store` (see
// supabaseStore.js). Policy:
//   - active subscription (subscription_expires_at in the future): unlimited
//   - otherwise `limit` premium requests per rolling window; the window starts
//     at the user's first request and resets once week_reset_at passes
//
// Fails OPEN: if the database is unreachable the request is allowed (and not
// counted) rather than locking everyone out over an outage. The free-tier Groq
// rate limits still cap the cost of that.

const config = require("../config");
const { createSupabaseStore } = require("./supabaseStore");
const { DAY_MS } = require("../utils/format");

function createUsageService({
  store,
  limit,
  windowMs = 7 * DAY_MS,
  pendingTtlMs = 24 * 60 * 60 * 1000,
  now = () => Date.now(),
  log = console,
}) {
  const enabled = Boolean(store);
  let degradedHandler = null;
  // Told about database failures so they can be surfaced (e.g. DM the admin);
  // without this a broken database looks exactly like "everyone is unlimited".
  const reportDegraded = (err) => {
    try {
      if (degradedHandler) degradedHandler(err);
    } catch (handlerErr) {
      log.error("[usage] degraded handler threw:", handlerErr && handlerErr.message);
    }
  };
  // Each lost race means someone else's request was counted, so a caller can
  // lose at most `limit` times before it sees the limit and stops.
  const maxAttempts = Math.max(5, limit + 3);
  const iso = (ms) => new Date(ms).toISOString();
  const isSubscribed = (user, t) =>
    Boolean(user.subscription_expires_at) && Date.parse(user.subscription_expires_at) > t;

  async function loadOrCreate(userId, t) {
    const existing = await store.getUser(userId);
    if (existing) return existing;
    const created = await store.createUser({
      telegram_user_id: userId,
      weekly_request_count: 0,
      week_reset_at: iso(t + windowMs),
    });
    // createUser returns null if another request inserted the row first.
    return created || store.getUser(userId);
  }

  /**
   * Call before doing a premium feature. If `allowed`, the request has already
   * been counted (when `counted`) — pass the result to refund() if the feature
   * then fails to deliver.
   */
  async function checkAndConsume(userId) {
    if (!enabled) return { allowed: true, counted: false, disabled: true };

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const t = now();
        const user = await loadOrCreate(userId, t);
        if (!user) continue;

        if (isSubscribed(user, t)) return { allowed: true, counted: false, subscribed: true };

        const resetAt = Date.parse(user.week_reset_at);

        if (resetAt <= t) {
          if (limit < 1) return { allowed: false, limit, resetAt: t + windowMs };
          const row = await store.tryResetWindow(userId, iso(t), iso(t + windowMs));
          if (row) return { allowed: true, counted: true, used: 1, limit };
          continue;
        }

        if (user.weekly_request_count >= limit) return { allowed: false, limit, resetAt };

        const row = await store.tryIncrement(userId, user.weekly_request_count, iso(t));
        if (row) return { allowed: true, counted: true, used: row.weekly_request_count, limit };
      }

      log.warn(`[usage] gave up after ${maxAttempts} contended attempts for user ${userId}; allowing uncounted`);
      return { allowed: true, counted: false, degraded: true };
    } catch (err) {
      log.error(`[usage] check failed for user ${userId}, allowing request (limits NOT enforced):`, err && err.message);
      reportDegraded(err);
      return { allowed: true, counted: false, degraded: true };
    }
  }

  /** Give back the request counted by checkAndConsume (feature failed/bailed). */
  async function refund(userId, gate) {
    if (!enabled || !gate || !gate.counted) return;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const t = now();
        const user = await store.getUser(userId);
        if (!user || user.weekly_request_count <= 0) return;
        if (Date.parse(user.week_reset_at) <= t) return; // window rolled over; nothing to give back
        if (await store.tryDecrement(userId, user.weekly_request_count, iso(t))) return;
      }
    } catch (err) {
      log.error(`[usage] refund failed for user ${userId}:`, err && err.message);
    }
  }

  /** Marks that the user was shown the paywall and may now send a receipt photo. */
  async function markPaymentPending(userId) {
    if (!enabled) return false;
    try {
      await store.upsert(userId, { payment_pending_at: iso(now()) });
      return true;
    } catch (err) {
      log.error(`[usage] could not mark payment pending for user ${userId}:`, err && err.message);
      return false;
    }
  }

  /**
   * { pending, subscribed, subscribedUntil } — pending means a receipt photo is
   * expected; subscribedUntil is the expiry in ms while subscribed, else null.
   */
  async function getPaymentState(userId) {
    const none = { pending: false, subscribed: false, subscribedUntil: null };
    if (!enabled) return none;
    try {
      const user = await store.getUser(userId);
      if (!user) return none;
      const t = now();
      const subscribed = isSubscribed(user, t);
      const pending =
        !subscribed &&
        Boolean(user.payment_pending_at) &&
        t - Date.parse(user.payment_pending_at) < pendingTtlMs;
      return { pending, subscribed, subscribedUntil: subscribed ? Date.parse(user.subscription_expires_at) : null };
    } catch (err) {
      log.error(`[usage] could not read payment state for user ${userId}:`, err && err.message);
      return none;
    }
  }

  /** Startup/status check that the database is reachable and correctly set up. */
  async function probe() {
    if (!enabled) return { ok: false, error: "monetization is not enabled" };
    try {
      const { warnings = [] } = (await store.ping()) || {};
      return { ok: warnings.length === 0, warnings, error: warnings.join("; ") || undefined };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  }

  /** Everything /status shows: is enforcement on, does the DB answer, and this user's record. */
  async function diagnose(userId) {
    const report = { enabled, limit, db: await probe(), user: null };
    if (enabled && report.db.ok) {
      try {
        const row = await store.getUser(userId);
        if (row) {
          const t = now();
          report.user = {
            used: row.weekly_request_count,
            resetAt: Date.parse(row.week_reset_at),
            subscribedUntil: isSubscribed(row, t) ? Date.parse(row.subscription_expires_at) : null,
            windowExpired: Date.parse(row.week_reset_at) <= t,
          };
        }
      } catch (err) {
        report.db = { ok: false, error: err && err.message };
      }
    }
    return report;
  }

  /** Admin approved: subscription runs for `days` from now. Returns expiry (ms). Throws on failure. */
  async function activateSubscription(userId, days) {
    if (!enabled) throw new Error("Monetization is not enabled");
    const expiresAt = now() + days * DAY_MS;
    await store.upsert(userId, { subscription_expires_at: iso(expiresAt), payment_pending_at: null });
    return expiresAt;
  }

  /**
   * Admin rejected: keep the payment "pending" (freshly) so the user's corrected
   * receipt is still routed to the admin rather than compressed as an image.
   */
  async function rejectPayment(userId) {
    if (!enabled) throw new Error("Monetization is not enabled");
    await store.upsert(userId, { payment_pending_at: iso(now()) });
  }

  return {
    enabled,
    limit,
    checkAndConsume,
    refund,
    markPaymentPending,
    getPaymentState,
    activateSubscription,
    rejectPayment,
    probe,
    diagnose,
    setDegradedHandler(fn) {
      degradedHandler = fn;
    },
  };
}

const store = config.MONETIZATION_ENABLED
  ? createSupabaseStore({ url: config.SUPABASE_URL, key: config.SUPABASE_KEY })
  : null;

const usage = createUsageService({
  store,
  limit: config.FREE_REQUESTS_PER_WEEK,
  pendingTtlMs: config.PENDING_PAYMENT_TTL_HOURS * 60 * 60 * 1000,
});

module.exports = { createUsageService, usage };

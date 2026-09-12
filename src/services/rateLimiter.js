// In-memory MVP rate limiting. Two layers:
//   - a per-user daily counter, so one user can't burn the whole free-tier budget
//   - a global per-minute counter, so we back off before hitting Groq's per-minute caps
//
// Redis/DB upgrade path: replace `dailyUserCounts` with Redis INCR + EXPIRE on
// key `voicesum:daily:<userId>:<date>`, and `globalMinuteWindows` with the same
// pattern on `voicesum:min:<kind>`. Needed once this runs across multiple
// instances or must survive restarts.

const dailyUserCounts = new Map(); // `${userId}:${dateStr}` -> count
const globalMinuteWindows = new Map(); // kind -> { windowStart, count }

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Checks and records one use against a user's daily quota.
 * @returns {{ allowed: boolean, count: number }}
 */
function checkAndRecordDailyUser(userId, limit) {
  const key = `${userId}:${todayKey()}`;
  const count = dailyUserCounts.get(key) || 0;

  if (count >= limit) {
    return { allowed: false, count };
  }

  dailyUserCounts.set(key, count + 1);
  return { allowed: true, count: count + 1 };
}

/**
 * Fixed-window per-minute limiter shared across all users for a given kind
 * (e.g. "whisper" or "llm"). Returns false if the call should be rejected.
 */
function checkGlobalMinuteRate(kind, limitPerMinute) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const entry = globalMinuteWindows.get(kind);

  if (!entry || now - entry.windowStart >= windowMs) {
    globalMinuteWindows.set(kind, { windowStart: now, count: 1 });
    return true;
  }

  if (entry.count >= limitPerMinute) {
    return false;
  }

  entry.count += 1;
  return true;
}

module.exports = { checkAndRecordDailyUser, checkGlobalMinuteRate };

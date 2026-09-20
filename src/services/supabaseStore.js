// Thin Supabase (PostgREST) client for the `users` table, using plain fetch —
// same "no SDK" approach as groqClient.js. See supabase/schema.sql.
//
// The try* methods are conditional updates (compare-and-set): each PATCH
// carries a filter describing the state the caller last read, and returns the
// updated row only if that filter still matched. usage.js retries when they
// return null, which is what keeps two concurrent requests from the same user
// from both squeezing under the weekly limit.

const DEFAULT_TIMEOUT_MS = 10 * 1000;

function assertUserId(id) {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid telegram_user_id: ${id}`);
  }
  return id;
}

function createSupabaseStore({
  url,
  key,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const base = `${url}/rest/v1/users`;

  async function request(method, query, { body, prefer } = {}) {
    const res = await fetchImpl(`${base}${query}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Supabase ${method} users failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }

  const enc = encodeURIComponent;

  return {
    async getUser(id) {
      assertUserId(id);
      const rows = await request("GET", `?telegram_user_id=eq.${id}&select=*&limit=1`);
      return rows[0] || null;
    },

    // Inserts the row unless it already exists (returns null in that case).
    async createUser(row) {
      assertUserId(row.telegram_user_id);
      const rows = await request("POST", "?on_conflict=telegram_user_id", {
        body: row,
        prefer: "return=representation,resolution=ignore-duplicates",
      });
      return rows[0] || null;
    },

    // Insert-or-merge: only the given fields change on an existing row; a new
    // row gets the column defaults for everything else.
    async upsert(id, fields) {
      assertUserId(id);
      const rows = await request("POST", "?on_conflict=telegram_user_id", {
        body: { telegram_user_id: id, ...fields },
        prefer: "return=representation,resolution=merge-duplicates",
      });
      return rows[0] || null;
    },

    // count -> count + 1, only if the count is still what the caller read and
    // the window hasn't expired in the meantime.
    async tryIncrement(id, expectedCount, nowIso) {
      assertUserId(id);
      const rows = await request(
        "PATCH",
        `?telegram_user_id=eq.${id}&weekly_request_count=eq.${expectedCount}&week_reset_at=gt.${enc(nowIso)}`,
        { body: { weekly_request_count: expectedCount + 1 }, prefer: "return=representation" }
      );
      return rows[0] || null;
    },

    // Start a fresh window (count = 1, this request), only if the old window is
    // still expired — so of two racing requests, exactly one performs the reset.
    async tryResetWindow(id, nowIso, newResetAtIso) {
      assertUserId(id);
      const rows = await request(
        "PATCH",
        `?telegram_user_id=eq.${id}&week_reset_at=lte.${enc(nowIso)}`,
        {
          body: { weekly_request_count: 1, week_reset_at: newResetAtIso },
          prefer: "return=representation",
        }
      );
      return rows[0] || null;
    },

    async tryDecrement(id, expectedCount, nowIso) {
      assertUserId(id);
      const rows = await request(
        "PATCH",
        `?telegram_user_id=eq.${id}&weekly_request_count=eq.${expectedCount}&week_reset_at=gt.${enc(nowIso)}`,
        { body: { weekly_request_count: expectedCount - 1 }, prefer: "return=representation" }
      );
      return rows[0] || null;
    },
  };
}

module.exports = { createSupabaseStore };

// Just enough of Supabase's PostgREST for the `users` table, as used by
// src/services/supabaseStore.js: GET with eq filters, POST insert/upsert with
// the Prefer resolution headers, and PATCH with eq/gt/lte filters returning the
// updated rows. It parses the real URLs and headers the store sends, so a
// wiring test exercises supabaseStore.js itself rather than a fake of it.
//
// It only knows what supabaseStore.js needs; behaviour of the real service
// beyond that (RLS, schema cache, etc.) is deliberately not modelled.

const DEFAULTS = () => ({
  weekly_request_count: 0,
  week_reset_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  subscription_expires_at: null,
  payment_pending_at: null,
});

function createPostgrestEmulator() {
  const rows = new Map();
  const requests = [];

  function matches(row, [column, expression]) {
    const dot = expression.indexOf(".");
    const op = expression.slice(0, dot);
    const raw = expression.slice(dot + 1);
    const isTime = column === "week_reset_at" || column.endsWith("_at");
    const left = isTime ? Date.parse(row[column]) : Number(row[column]);
    const right = isTime ? Date.parse(raw) : Number(raw);
    if (op === "eq") return left === right;
    if (op === "gt") return left > right;
    if (op === "lte") return left <= right;
    throw new Error(`emulator: unsupported operator ${op}`);
  }

  function filtered(url) {
    const conditions = [...url.searchParams.entries()].filter(([k]) => !["select", "limit", "on_conflict"].includes(k));
    return [...rows.values()].filter((row) => conditions.every((c) => matches(row, c)));
  }

  function respond(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }

  async function handle(urlString, init = {}) {
    const url = new URL(urlString);
    const method = init.method || "GET";
    const prefer = (init.headers && init.headers.Prefer) || "";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, url: urlString, body, prefer });

    if (!url.pathname.endsWith("/rest/v1/users")) return respond(404, { message: "no such table" });
    if (!init.headers || !init.headers.apikey || init.headers.Authorization !== `Bearer ${init.headers.apikey}`) {
      return respond(401, { message: "Invalid API key" });
    }

    if (method === "GET") {
      const limit = Number(url.searchParams.get("limit") || Infinity);
      return respond(200, filtered(url).slice(0, limit).map((r) => ({ ...r })));
    }

    if (method === "POST") {
      const id = body.telegram_user_id;
      const existing = rows.get(id);
      if (prefer.includes("ignore-duplicates")) {
        if (existing) return respond(201, []);
        const created = { ...DEFAULTS(), ...body };
        rows.set(id, created);
        return respond(201, [{ ...created }]);
      }
      if (prefer.includes("merge-duplicates")) {
        const merged = existing ? { ...existing, ...body } : { ...DEFAULTS(), ...body };
        rows.set(id, merged);
        return respond(201, [{ ...merged }]);
      }
      return respond(400, { message: "emulator: POST needs a resolution preference" });
    }

    if (method === "PATCH") {
      const matched = filtered(url);
      for (const row of matched) Object.assign(rows.get(row.telegram_user_id), body);
      return respond(200, matched.map((r) => ({ ...rows.get(r.telegram_user_id) })));
    }

    return respond(405, { message: "method not allowed" });
  }

  return { handle, rows, requests };
}

module.exports = { createPostgrestEmulator };

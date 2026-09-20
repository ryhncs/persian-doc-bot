const test = require("node:test");
const assert = require("node:assert/strict");

const { createSupabaseStore } = require("../src/services/supabaseStore");

function mockFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const next = queue.shift() || { status: 200, body: [] };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)),
    };
  };
  return { fetchImpl, calls };
}

function storeWith(responses) {
  const { fetchImpl, calls } = mockFetch(responses);
  const store = createSupabaseStore({ url: "https://proj.supabase.co", key: "service-key", fetchImpl });
  return { store, calls };
}

test("getUser: GET with the id filter, service-key auth headers, returns the first row", async () => {
  const row = { telegram_user_id: 42, weekly_request_count: 2 };
  const { store, calls } = storeWith([{ status: 200, body: [row] }]);

  assert.deepEqual(await store.getUser(42), row);

  assert.equal(calls[0].init.method, "GET");
  assert.equal(
    calls[0].url,
    "https://proj.supabase.co/rest/v1/users?telegram_user_id=eq.42&select=*&limit=1"
  );
  assert.equal(calls[0].init.headers.apikey, "service-key");
  assert.equal(calls[0].init.headers.Authorization, "Bearer service-key");
});

test("getUser: returns null when there is no row", async () => {
  const { store } = storeWith([{ status: 200, body: [] }]);
  assert.equal(await store.getUser(42), null);
});

test("createUser: insert that ignores duplicates, null if the row already existed", async () => {
  const row = { telegram_user_id: 42, weekly_request_count: 0, week_reset_at: "2026-09-27T12:00:00.000Z" };
  const { store, calls } = storeWith([
    { status: 201, body: [row] },
    { status: 201, body: [] },
  ]);

  assert.deepEqual(await store.createUser(row), row);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].url, "https://proj.supabase.co/rest/v1/users?on_conflict=telegram_user_id");
  assert.equal(calls[0].init.headers.Prefer, "return=representation,resolution=ignore-duplicates");
  assert.deepEqual(calls[0].body, row);

  assert.equal(await store.createUser(row), null);
});

test("upsert: merge-duplicates so only the given fields change, id included in the body", async () => {
  const { store, calls } = storeWith([{ status: 201, body: [{ telegram_user_id: 42 }] }]);
  await store.upsert(42, { payment_pending_at: null });

  assert.equal(calls[0].init.headers.Prefer, "return=representation,resolution=merge-duplicates");
  assert.deepEqual(calls[0].body, { telegram_user_id: 42, payment_pending_at: null });
});

test("tryIncrement: conditional PATCH on the last-read count and an unexpired window", async () => {
  const updated = { telegram_user_id: 42, weekly_request_count: 3 };
  const { store, calls } = storeWith([{ status: 200, body: [updated] }]);

  const now = "2026-09-20T12:00:00.000Z";
  assert.deepEqual(await store.tryIncrement(42, 2, now), updated);

  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(
    calls[0].url,
    `https://proj.supabase.co/rest/v1/users?telegram_user_id=eq.42&weekly_request_count=eq.2&week_reset_at=gt.${encodeURIComponent(now)}`
  );
  assert.deepEqual(calls[0].body, { weekly_request_count: 3 });
  assert.equal(calls[0].init.headers.Prefer, "return=representation");
});

test("tryIncrement: null when the filter no longer matches (lost the race)", async () => {
  const { store } = storeWith([{ status: 200, body: [] }]);
  assert.equal(await store.tryIncrement(42, 2, "2026-09-20T12:00:00.000Z"), null);
});

test("tryResetWindow: only matches an expired window, sets count 1 and a new reset time", async () => {
  const { store, calls } = storeWith([{ status: 200, body: [{ weekly_request_count: 1 }] }]);
  const now = "2026-09-28T12:00:00.000Z";
  const next = "2026-10-05T12:00:00.000Z";

  await store.tryResetWindow(42, now, next);

  assert.equal(
    calls[0].url,
    `https://proj.supabase.co/rest/v1/users?telegram_user_id=eq.42&week_reset_at=lte.${encodeURIComponent(now)}`
  );
  assert.deepEqual(calls[0].body, { weekly_request_count: 1, week_reset_at: next });
});

test("tryDecrement: conditional PATCH lowering the count by one", async () => {
  const { store, calls } = storeWith([{ status: 200, body: [{ weekly_request_count: 1 }] }]);
  const now = "2026-09-20T12:00:00.000Z";

  await store.tryDecrement(42, 2, now);

  assert.equal(
    calls[0].url,
    `https://proj.supabase.co/rest/v1/users?telegram_user_id=eq.42&weekly_request_count=eq.2&week_reset_at=gt.${encodeURIComponent(now)}`
  );
  assert.deepEqual(calls[0].body, { weekly_request_count: 1 });
});

test("non-2xx responses throw with the status and body", async () => {
  const { store } = storeWith([{ status: 401, body: { message: "Invalid API key" } }]);
  await assert.rejects(() => store.getUser(42), /401.*Invalid API key/);
});

test("rejects invalid user ids before making any request", async () => {
  const { store, calls } = storeWith([]);
  await assert.rejects(() => store.getUser("42; drop table users"), /Invalid telegram_user_id/);
  await assert.rejects(() => store.upsert(-1, {}), /Invalid telegram_user_id/);
  await assert.rejects(() => store.tryIncrement(NaN, 0, "x"), /Invalid telegram_user_id/);
  assert.equal(calls.length, 0);
});

// PGRST125 "Invalid path specified in request URL" on staging: the env var had
// a path in it, so the request went to /rest/v1/rest/v1/users.
test("SUPABASE_URL is normalized: whatever way it was pasted, requests go to <project>/rest/v1/users", async () => {
  const pasted = [
    "https://proj.supabase.co",
    "https://proj.supabase.co/",
    "https://proj.supabase.co/rest/v1",
    "https://proj.supabase.co/rest/v1/",
    "  https://proj.supabase.co/rest/v1/  ",
    '"https://proj.supabase.co"',
    "proj.supabase.co",
  ];
  for (const url of pasted) {
    const { fetchImpl, calls } = mockFetch([{ status: 200, body: [] }]);
    await createSupabaseStore({ url, key: "k", fetchImpl }).getUser(1);
    assert.equal(
      calls[0].url,
      "https://proj.supabase.co/rest/v1/users?telegram_user_id=eq.1&select=*&limit=1",
      `for ${JSON.stringify(url)}`
    );
  }
});

test("a failed request names the endpoint (never the key) so a wrong URL is obvious", async () => {
  const { store } = storeWith([
    { status: 404, body: { code: "PGRST125", message: "Invalid path specified in request URL" } },
  ]);
  await assert.rejects(
    () => store.ping(),
    (err) => {
      assert.match(err.message, /https:\/\/proj\.supabase\.co\/rest\/v1\/users failed \(404\)/);
      assert.match(err.message, /PGRST125/);
      assert.doesNotMatch(err.message, /service-key/);
      return true;
    }
  );
});

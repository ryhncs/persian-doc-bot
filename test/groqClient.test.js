process.env.GROQ_API_KEY = "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { groqFetch, GroqRateLimitError, GroqApiError } = require("../src/services/groqClient");

function withFetch(response, body) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: { get: (name) => (response.headers || {})[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  return () => {
    globalThis.fetch = original;
  };
}

test("a 429 carries Groq's Retry-After (seconds) as milliseconds", async () => {
  const restore = withFetch({ status: 429, headers: { "retry-after": "7" } }, {});
  try {
    await assert.rejects(
      () => groqFetch("/chat/completions", { method: "POST", body: "{}" }),
      (err) => err instanceof GroqRateLimitError && err.retryAfterMs === 7000 && err.status === 429
    );
  } finally {
    restore();
  }
});

test("a fractional Retry-After is rounded up", async () => {
  const restore = withFetch({ status: 429, headers: { "retry-after": "2.3" } }, {});
  try {
    await assert.rejects(
      () => groqFetch("/x"),
      (err) => err.retryAfterMs === 2300
    );
  } finally {
    restore();
  }
});

test("a 429 without the header still throws a GroqRateLimitError, with no retryAfterMs", async () => {
  const restore = withFetch({ status: 429 }, {});
  try {
    await assert.rejects(
      () => groqFetch("/x"),
      (err) => err instanceof GroqRateLimitError && err.retryAfterMs === undefined
    );
  } finally {
    restore();
  }
});

test("a response object with no headers at all (test doubles) is tolerated", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "" });
  try {
    await assert.rejects(() => groqFetch("/x"), GroqRateLimitError);
  } finally {
    globalThis.fetch = original;
  }
});

test("other failures stay plain GroqApiErrors (a 413 is not retryable)", async () => {
  const restore = withFetch({ status: 413 }, { error: { message: "Request too large" } });
  try {
    await assert.rejects(
      () => groqFetch("/x"),
      (err) => err instanceof GroqApiError && !(err instanceof GroqRateLimitError) && /Request too large/.test(err.message)
    );
  } finally {
    restore();
  }
});

test("success returns the parsed JSON", async () => {
  const restore = withFetch({ status: 200 }, { choices: [{ message: { content: "hi" } }] });
  try {
    assert.equal((await groqFetch("/x")).choices[0].message.content, "hi");
  } finally {
    restore();
  }
});

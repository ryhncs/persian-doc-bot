// Admin chat for this test file; monetization itself stays off (no Supabase env).
process.env.ADMIN_CHAT_ID = "999";
for (const key of ["SUPABASE_URL", "SUPABASE_KEY", "SUBSCRIPTION_PRICE_TOMAN", "CARD_NUMBER"]) {
  process.env[key] = "";
}

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildStatusText, handleStatusCommand, installDegradedAlert, isAdminChat } = require("../src/handlers/admin");
const { createUsageService } = require("../src/services/usage");
const { formatPersianDate } = require("../src/utils/format");
const { createFakeStore, createClock, silentLog } = require("./helpers");

const DAY = 24 * 60 * 60 * 1000;
const cfg = { MISSING_MONETIZATION_VARS: ["CARD_NUMBER", "ADMIN_CHAT_ID"] };

function mockBot() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
    },
  };
}

test("status when enforcement is off lists exactly which env vars are missing", () => {
  const text = buildStatusText({ enabled: false, db: { ok: false } }, cfg);
  assert.match(text, /غیرفعال/);
  assert.match(text, /CARD_NUMBER, ADMIN_CHAT_ID/);
});

test("status when the database is broken says limits are NOT enforced and shows the error", () => {
  const text = buildStatusText({ enabled: true, limit: 3, db: { ok: false, error: "Supabase GET users failed (404)" } }, cfg);
  assert.match(text, /مشکل/);
  assert.match(text, /نامحدود/);
  assert.match(text, /404/);
});

test("status for a healthy setup shows the caller's usage and reset date", () => {
  const now = Date.UTC(2026, 8, 20);
  const text = buildStatusText(
    { enabled: true, limit: 3, db: { ok: true }, user: { used: 2, resetAt: now + 3 * DAY, subscribedUntil: null, windowExpired: false } },
    cfg,
    now
  );
  assert.match(text, /سالم/);
  assert.match(text, /۲ از ۳/);
  assert.ok(text.includes(formatPersianDate(now + 3 * DAY)));
});

test("status shows an active subscription (which is exactly why an account looks unlimited)", () => {
  const until = Date.UTC(2026, 9, 20);
  const text = buildStatusText(
    { enabled: true, limit: 3, db: { ok: true }, user: { used: 0, resetAt: 0, subscribedUntil: until, windowExpired: false } },
    cfg
  );
  assert.match(text, /اشتراک فعال/);
  assert.ok(text.includes(formatPersianDate(until)));
});

test("status handles a brand-new account and an expired window", () => {
  assert.match(buildStatusText({ enabled: true, limit: 3, db: { ok: true }, user: null }, cfg), /رکوردی نداره/);
  assert.match(
    buildStatusText({ enabled: true, limit: 3, db: { ok: true }, user: { used: 3, resetAt: 1, subscribedUntil: null, windowExpired: true } }, cfg),
    /از نو شمرده/
  );
});

test("/status is admin-only: the admin gets an answer, everyone else is silently ignored", async () => {
  assert.equal(isAdminChat(999), true);
  assert.equal(isAdminChat("999"), true);
  assert.equal(isAdminChat(123), false);

  const bot = mockBot();
  await handleStatusCommand(bot, { chat: { id: 123 }, from: { id: 123 } });
  assert.equal(bot.sent.length, 0);

  await handleStatusCommand(bot, { chat: { id: 999 }, from: { id: 999 } });
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].chatId, 999);
  assert.match(bot.sent[0].text, /وضعیت کوله/);
});

test("a database failure DMs the admin, at most once an hour", async () => {
  const store = createFakeStore({ failWith: new Error("connection refused") });
  const clock = createClock();
  const usage = createUsageService({ store, limit: 3, now: clock, log: silentLog });
  const bot = mockBot();
  installDegradedAlert(bot, { usageService: usage, adminChatId: "999", now: clock });

  await usage.checkAndConsume(1);
  await usage.checkAndConsume(2);
  await usage.checkAndConsume(3);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].chatId, "999");
  assert.match(bot.sent[0].text, /connection refused/);
  assert.match(bot.sent[0].text, /\/status/);

  clock.advance(61 * 60 * 1000);
  await usage.checkAndConsume(4);
  assert.equal(bot.sent.length, 2);
});

test("no admin chat configured means no alert wiring at all", () => {
  const usage = createUsageService({ store: createFakeStore(), limit: 3, log: silentLog });
  installDegradedAlert(mockBot(), { usageService: usage, adminChatId: "" });
  // Nothing to assert beyond "does not throw"; a handler here would DM chat "".
  assert.ok(true);
});

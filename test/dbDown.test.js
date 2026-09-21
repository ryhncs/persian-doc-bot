// End-to-end: the real src/bot.js against (1) a SUPABASE_URL pasted the wrong
// way, which used to make every request 404 with PGRST125, and (2) a database
// that is completely down. In both cases the bot must keep serving users
// (fail open) and a payment receipt must still reach the admin.
//
// Only the outside world is faked: Telegram, Groq, file downloads, PDF helpers,
// and Supabase (the strict PostgREST emulator, which rejects any path but
// /rest/v1/users the way the real gateway does).

process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
process.env.GROQ_API_KEY = "test-groq-key";
// Quotes, spaces and a /rest/v1/ suffix: the ways this variable gets pasted wrong.
process.env.SUPABASE_URL = '  "http://supabase.test/rest/v1/"  ';
process.env.SUPABASE_KEY = "service-role-test-key";
process.env.SUBSCRIPTION_PRICE_TOMAN = "120000";
process.env.CARD_NUMBER = "6037-9911-2233-4455";
process.env.ADMIN_CHAT_ID = "999";
process.env.WEBHOOK_URL = "";
process.env.RENDER_EXTERNAL_URL = "";
process.env.MAX_DOCUMENT_CHARS_FOR_SUMMARY = "";
process.env.SUMMARY_MODEL = "openai/gpt-oss-120b";
process.env.GROQ_TPM_LIMIT = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const sharp = require("sharp");

const { createPostgrestEmulator } = require("./postgrestEmulator");

class FakeBot extends EventEmitter {
  constructor() {
    super();
    FakeBot.instance = this;
    this.sent = [];
    this.documents = [];
    this.photos = [];
    this.edits = [];
    this.deleted = [];
  }
  onText(regex, cb) {
    this.on("message", (msg) => {
      if (typeof msg.text !== "string") return;
      const match = msg.text.match(regex);
      if (match) cb(msg, match);
    });
  }
  async sendMessage(chatId, text, opts) {
    this.sent.push({ chatId, text, opts });
    return { message_id: this.sent.length };
  }
  async sendChatAction() {}
  async sendDocument(chatId, buffer, opts, fileOpts) {
    this.documents.push({ chatId, buffer, opts, fileOpts });
  }
  async sendPhoto(chatId, photo, opts) {
    this.photos.push({ chatId, photo, opts });
  }
  async answerCallbackQuery() {}
  async editMessageText(text, opts) {
    this.edits.push({ text, opts });
  }
  async editMessageCaption() {}
  async deleteMessage(chatId, messageId) {
    this.deleted.push({ chatId, messageId });
  }
  async getFileLink(fileId) {
    return `http://tg.test/file/${fileId}`;
  }
  async setWebHook() {}
  messagesTo(chatId) {
    return this.sent.filter((m) => String(m.chatId) === String(chatId));
  }
}
const fakeLibPath = require.resolve("node-telegram-bot-api");
require.cache[fakeLibPath] = { id: fakeLibPath, filename: fakeLibPath, loaded: true, exports: FakeBot };

for (const [file, exports] of [
  ["../src/services/pdfText", { extractPdfText: async () => ({ text: "A short lecture note about gradient descent and learning rates.", numPages: 1 }) }],
  ["../src/services/pdfCompress", { compressPdf: async () => Buffer.from("tiny-pdf") }],
]) {
  const resolved = require.resolve(file);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const emulator = createPostgrestEmulator();
let dbDown = false;
let jpeg;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://supabase.test")) {
    if (dbDown) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => '{"code":"PGRST125","message":"Invalid path specified in request URL"}',
        json: async () => ({}),
      };
    }
    return emulator.handle(u, init);
  }
  if (u.includes("api.groq.com")) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: "نتیجه‌ی آزمایشی" }, finish_reason: "stop" }], usage: { total_tokens: 500 } }),
      text: async () => "",
    };
  }
  if (u.startsWith("http://tg.test/file/")) {
    const bytes = u.includes("photo") ? jpeg : Buffer.from("%PDF-1.4 fake");
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }
  throw new Error(`unexpected fetch: ${u}`);
};

require("../src/bot");
const bot = FakeBot.instance;
const { MENU } = require("../src/handlers/menu");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const user = (id) => ({ id, first_name: `User${id}`, username: `user${id}` });
const say = (id, text) => bot.emit("message", { chat: { id }, from: user(id), text });
const photoMsg = (id) => ({ chat: { id }, from: user(id), photo: [{ file_id: "photo-small" }, { file_id: "photo-large" }] });
function sendPhoto(id) {
  bot.emit("message", photoMsg(id));
  bot.emit("photo", photoMsg(id));
}
function sendPdf(id) {
  bot.emit("document", { chat: { id }, from: user(id), document: { file_id: "doc-1", file_name: "notes.pdf", mime_type: "application/pdf", file_size: 1000 } });
}
const lastTo = (id) => bot.messagesTo(id).at(-1);
const countTo = (id) => bot.messagesTo(id).length;

test.before(async () => {
  jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg({ quality: 95 }).toBuffer();
  await waitFor(() => emulator.requests.length > 0, "startup probe");
});

test("a SUPABASE_URL pasted with quotes, spaces and /rest/v1/ still reaches the real endpoint", async () => {
  assert.ok(emulator.requests.length > 0);
  for (const r of emulator.requests) {
    assert.equal(new URL(r.url).pathname, "/rest/v1/users", r.url);
  }
  say(999, "/status");
  await waitFor(() => countTo(999) >= 1, "status reply");
  assert.match(lastTo(999).text, /اتصال Supabase: سالم ✅/);
});

test("limits are enforced with that URL: 3 free requests, then the paywall", async () => {
  for (let i = 0; i < 3; i++) {
    const before = countTo(301);
    say(301, MENU.TRANSLATE);
    await waitFor(() => countTo(301) === before + 1, "prompt");
    say(301, "Some text to translate.");
    await waitFor(() => countTo(301) === before + 3, "processing + result");
  }
  const before = countTo(301);
  say(301, MENU.TRANSLATE);
  await waitFor(() => countTo(301) === before + 1, "prompt");
  say(301, "Fourth.");
  await waitFor(() => countTo(301) === before + 2, "paywall");
  assert.match(lastTo(301).text, /سهمیه‌ی رایگان/);
});

test("DATABASE DOWN: /status says so, and the admin is told", async () => {
  dbDown = true;
  const before = countTo(999);
  say(999, "/status");
  await waitFor(() => countTo(999) > before, "status reply");
  assert.match(lastTo(999).text, /اتصال Supabase: مشکل ❌/);
  assert.match(lastTo(999).text, /PGRST125/);
});

test("DATABASE DOWN: a PDF summary still completes (fail open) and is not aborted", async () => {
  say(401, MENU.PDF);
  await waitFor(() => countTo(401) === 1, "prompt");
  sendPdf(401);
  await waitFor(() => lastTo(401).text === "نتیجه‌ی آزمایشی", "summary delivered");
  assert.ok(!bot.messagesTo(401).some((m) => /مشکل مواجه شد/.test(m.text)), "no error message");
  assert.ok(!bot.messagesTo(401).some((m) => /PGRST|Supabase/.test(m.text)), "database error never shown to the user");
});

test("DATABASE DOWN: voice/translate flow also works", async () => {
  say(402, MENU.TRANSLATE);
  await waitFor(() => countTo(402) === 1, "prompt");
  say(402, "Some text to translate.");
  await waitFor(() => countTo(402) === 3, "processing + result");
  assert.equal(lastTo(402).text, "نتیجه‌ی آزمایشی");
});

test("DATABASE DOWN: after 💳, the receipt photo goes to the admin instead of being compressed", async () => {
  const docsBefore = bot.documents.length;
  say(403, MENU.SUBSCRIBE);
  await waitFor(() => countTo(403) === 1, "subscription info");
  assert.match(lastTo(403).text, /6037-9911-2233-4455/);

  sendPhoto(403);
  await waitFor(() => bot.photos.some((p) => String(p.chatId) === "999" && /403/.test(p.opts.caption)), "receipt forwarded");
  assert.equal(bot.documents.length, docsBefore, "not compressed");
  assert.match(lastTo(403).text, /رسیدت برای بررسی ارسال شد/);
});

test("DATABASE DOWN: a photo from someone who never saw the paywall is still compressed", async () => {
  const docsBefore = bot.documents.length;
  sendPhoto(404);
  await waitFor(() => bot.documents.length === docsBefore + 1, "compressed image");
});

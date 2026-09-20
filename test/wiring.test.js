// End-to-end wiring: the real src/bot.js, real handlers, real usage service and
// real supabaseStore, with only the outside world faked: Telegram (an
// EventEmitter bot), Supabase (an offline PostgREST emulator), Groq (a canned
// completion), file downloads, and the two binaries-backed PDF helpers.

process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_KEY = "service-role-test-key";
process.env.SUBSCRIPTION_PRICE_TOMAN = "120000";
process.env.CARD_NUMBER = "6037-9911-2233-4455";
process.env.ADMIN_CHAT_ID = "999";
process.env.ADMIN_CONTACT = "@kooleh_admin";
process.env.WEBHOOK_URL = "";
process.env.RENDER_EXTERNAL_URL = "";
process.env.MAX_DOCUMENT_CHARS_FOR_SUMMARY = "";
process.env.SUMMARY_MODEL = "openai/gpt-oss-120b";
process.env.GROQ_TPM_LIMIT = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const sharp = require("sharp");

const { createPostgrestEmulator } = require("./postgrestEmulator");

// --- fake node-telegram-bot-api -------------------------------------------
class FakeBot extends EventEmitter {
  constructor() {
    super();
    FakeBot.instance = this;
    this.sent = []; // sendMessage
    this.documents = [];
    this.photos = [];
    this.answers = [];
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
  async answerCallbackQuery(id, opts) {
    this.answers.push({ id, opts });
  }
  async editMessageText(text, opts) {
    this.edits.push({ text, opts });
  }
  async editMessageCaption(text, opts) {
    this.edits.push({ text, opts, caption: true });
  }
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

// --- fake pdf helpers (avoid pdf-parse's quirks and the Ghostscript binary) --
const PDF_TEXT = "This is a short lecture note about gradient descent and learning rates in machine learning.";
let pdfTextValue = PDF_TEXT; // tests swap this to simulate long / scanned documents
for (const [file, exports] of [
  ["../src/services/pdfText", { extractPdfText: async () => ({ text: pdfTextValue, numPages: 1 }) }],
  ["../src/services/pdfCompress", { compressPdf: async (buf) => Buffer.from("tiny-pdf") }],
]) {
  const resolved = require.resolve(file);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// --- fake network: Supabase, Groq, Telegram file downloads ------------------
const emulator = createPostgrestEmulator();
const groqCalls = [];
let jpeg;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://supabase.test")) return emulator.handle(u, init);

  if (u.includes("api.groq.com")) {
    groqCalls.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: "نتیجه‌ی آزمایشی" }, finish_reason: "stop" }],
        usage: { total_tokens: 500 },
      }),
      text: async () => "",
    };
  }

  if (u.startsWith("http://tg.test/file/")) {
    const bytes = u.includes("photo") ? jpeg : Buffer.from("%PDF-1.4 fake");
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }

  throw new Error(`unexpected fetch in wiring test: ${u}`);
};

// --- load the real bot ------------------------------------------------------
require("../src/bot");
const bot = FakeBot.instance;

const { MENU } = require("../src/handlers/menu");
const { WELCOME_TEXT } = require("../src/messages");

// --- helpers ----------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const user = (id, extra = {}) => ({ id, first_name: `User${id}`, username: `user${id}`, ...extra });
function say(id, text) {
  bot.emit("message", { chat: { id }, from: user(id), text });
}
function sendPhoto(id) {
  bot.emit("message", { chat: { id }, from: user(id), photo: [{ file_id: "photo-small" }, { file_id: "photo-large" }] });
  bot.emit("photo", { chat: { id }, from: user(id), photo: [{ file_id: "photo-small" }, { file_id: "photo-large" }] });
}
function sendPdf(id, name = "notes.pdf") {
  bot.emit("document", {
    chat: { id },
    from: user(id),
    document: { file_id: "doc-1", file_name: name, mime_type: "application/pdf", file_size: 1000 },
  });
}
function press(fromId, chatId, data) {
  bot.emit("callback_query", { id: `cb-${Math.random()}`, from: { id: fromId }, message: { chat: { id: chatId }, message_id: 5, caption: "receipt" }, data });
}
const lastTo = (id) => bot.messagesTo(id).at(-1);
const countTo = (id) => bot.messagesTo(id).length;

test.before(async () => {
  jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg({ quality: 95 }).toBuffer();
  // let the startup probe finish
  await waitFor(() => emulator.requests.some((r) => r.url.includes("select=telegram_user_id&limit=1")), "startup probe");
});

// --- /start, /help ----------------------------------------------------------
test("/start sends the exact welcome text with the persistent five-button menu", async () => {
  say(101, "/start");
  await waitFor(() => countTo(101) === 1, "welcome");
  const msg = lastTo(101);
  assert.equal(msg.text, WELCOME_TEXT);
  assert.equal(msg.opts.reply_markup.is_persistent, true);
  assert.deepEqual(msg.opts.reply_markup.keyboard.flat(), [MENU.VOICE, MENU.PDF, MENU.TRANSLATE, MENU.COMPRESS, MENU.SUBSCRIBE]);
});

test("/help repeats the menu keyboard", async () => {
  say(102, "/help");
  await waitFor(() => countTo(102) === 1, "help");
  assert.equal(lastTo(102).opts.reply_markup.is_persistent, true);
});

// --- existing behaviour is unchanged ------------------------------------------
test("a plain text message still becomes a Word file, with the two translate buttons", async () => {
  say(111, "یه متن معمولی برای تبدیل به ورد");
  await waitFor(() => bot.documents.some((d) => d.chatId === 111) && countTo(111) === 1, "docx + buttons");
  assert.equal(bot.documents.find((d) => d.chatId === 111).fileOpts.filename, "document.docx");
  const buttons = lastTo(111).opts.reply_markup.inline_keyboard[0];
  assert.deepEqual(buttons.map((b) => b.callback_data.split(":").slice(0, 2).join(":")), ["txt:translate", "txt:toEnglish"]);
  assert.equal(groqCalls.length, 0, "no LLM call until a button is pressed");
});

test("menu labels are never converted to Word files", async () => {
  const before = bot.documents.length;
  for (const label of Object.values(MENU)) say(112, label);
  await waitFor(() => countTo(112) === 5, "five menu replies");
  assert.equal(bot.documents.length, before);
});

// --- menu flows ---------------------------------------------------------------
test("🌐 then a text translates it directly (no Word file), and the mode is one-shot", async () => {
  const docsBefore = bot.documents.length;
  say(121, MENU.TRANSLATE);
  await waitFor(() => countTo(121) === 1, "translate prompt");

  say(121, "Gradient descent minimizes a loss function.");
  await waitFor(() => countTo(121) === 3, "processing + result");
  const result = lastTo(121);
  assert.equal(result.text, "نتیجه‌ی آزمایشی");
  assert.deepEqual(result.opts.reply_markup.inline_keyboard[0].map((b) => b.text), ["متن اصلی", "خروجی Word"]);
  assert.equal(bot.documents.length, docsBefore, "translate mode skips the Word export");

  say(121, "next text is just a normal text again");
  await waitFor(() => bot.documents.some((d) => d.chatId === 121), "docx for the following text");
});

test("the inline translate buttons under a Word export still work", async () => {
  say(122, "Hello world");
  await waitFor(() => countTo(122) === 1, "buttons");
  press(122, 122, lastTo(122).opts.reply_markup.inline_keyboard[0][1].callback_data); // toEnglish
  await waitFor(() => countTo(122) === 3, "english result");
  assert.equal(lastTo(122).text, "نتیجه‌ی آزمایشی");
});

test("📄 then a PDF summarizes it directly, skipping the summarize-or-compress question", async () => {
  say(131, MENU.PDF);
  await waitFor(() => countTo(131) === 1, "pdf prompt");

  sendPdf(131);
  await waitFor(() => lastTo(131) && lastTo(131).text === "نتیجه‌ی آزمایشی", "summary");
  assert.ok(!bot.messagesTo(131).some((m) => /چیکارش کنم/.test(m.text)), "no choice question");
  assert.deepEqual(lastTo(131).opts.reply_markup.inline_keyboard[0].map((b) => b.text), ["متن کامل", "خروجی Word"]);
});

test("a PDF sent with no menu choice still asks: summarize or compress", async () => {
  sendPdf(132);
  await waitFor(() => countTo(132) === 1, "choice");
  assert.match(lastTo(132).text, /چیکارش کنم/);
  const data = lastTo(132).opts.reply_markup.inline_keyboard[0].map((b) => b.callback_data.split(":").slice(0, 2).join(":"));
  assert.deepEqual(data, ["doc:summarize", "doc:compress"]);

  press(132, 132, lastTo(132).opts.reply_markup.inline_keyboard[0][0].callback_data);
  await waitFor(() => lastTo(132).text === "نتیجه‌ی آزمایشی", "summary via button");
});

test("🗜 then a PDF compresses it directly", async () => {
  say(141, MENU.COMPRESS);
  await waitFor(() => countTo(141) === 1, "compress prompt");
  sendPdf(141, "lecture.pdf");
  await waitFor(() => bot.documents.some((d) => d.chatId === 141), "compressed pdf");
  assert.equal(bot.documents.find((d) => d.chatId === 141).fileOpts.filename, "compressed-lecture.pdf");
});

test("🗜 then a photo compresses it, and a photo with no mode still compresses (unchanged)", async () => {
  say(142, MENU.COMPRESS);
  await waitFor(() => countTo(142) === 1, "prompt");
  sendPhoto(142);
  await waitFor(() => bot.documents.some((d) => d.chatId === 142), "compressed photo");
  assert.equal(bot.documents.find((d) => d.chatId === 142).fileOpts.filename, "compressed.jpg");

  const before = bot.documents.length;
  sendPhoto(143);
  await waitFor(() => bot.documents.length === before + 1, "compressed photo without mode");
});

// --- quota, paywall, payment --------------------------------------------------
async function useOneFreeRequest(id) {
  const before = countTo(id);
  say(id, MENU.TRANSLATE);
  await waitFor(() => countTo(id) === before + 1, "prompt");
  say(id, "Some text to translate.");
  await waitFor(() => countTo(id) === before + 3, "result");
}

test("3 free requests, then the paywall (and no 4th Groq call)", async () => {
  const groqBefore = groqCalls.length;
  for (let i = 0; i < 3; i++) await useOneFreeRequest(151);
  assert.equal(groqCalls.length, groqBefore + 3);

  const before = countTo(151);
  say(151, MENU.TRANSLATE);
  await waitFor(() => countTo(151) === before + 1, "prompt");
  say(151, "A fourth text.");
  await waitFor(() => countTo(151) === before + 2, "paywall");

  const paywall = lastTo(151);
  assert.equal(paywall.opts.parse_mode, "HTML");
  assert.match(paywall.text, /سهمیه‌ی رایگان/);
  assert.match(paywall.text, /۱۲۰٬۰۰۰ تومان/);
  assert.match(paywall.text, /روزی کمتر از یه بلیط مترو/);
  assert.match(paywall.text, /<code>6037-9911-2233-4455<\/code>/);
  assert.equal(groqCalls.length, groqBefore + 3, "the blocked request never reached Groq");
});

test("REGRESSION: the admin's own account is limited just like everyone else", async () => {
  for (let i = 0; i < 3; i++) await useOneFreeRequest(999);
  const before = countTo(999);
  say(999, MENU.TRANSLATE);
  await waitFor(() => countTo(999) === before + 1, "prompt");
  say(999, "Fourth request from the admin account.");
  await waitFor(() => countTo(999) === before + 2, "paywall");
  assert.match(lastTo(999).text, /سهمیه‌ی رایگان/);
});

test("a receipt photo from a paywalled user goes to the admin, not to compression", async () => {
  const docsBefore = bot.documents.length;
  sendPhoto(151);
  await waitFor(() => bot.photos.some((p) => p.caption === undefined && String(p.chatId) === "999" && /151/.test(p.opts.caption)), "forwarded receipt");

  const forwarded = bot.photos.find((p) => /151/.test(p.opts.caption));
  assert.equal(forwarded.photo, "photo-large");
  assert.deepEqual(forwarded.opts.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["pay:approve:151", "pay:reject:151"]);
  assert.match(lastTo(151).text, /رسیدت برای بررسی ارسال شد/);
  assert.equal(bot.documents.length, docsBefore, "not compressed");
});

test("admin approves: subscription saved for 30 days, user told, and now unlimited", async () => {
  press(999, 999, "pay:approve:151");
  await waitFor(() => /اشتراک کوله فعال شد/.test(lastTo(151).text), "approval notice");

  const row = emulator.rows.get(151);
  const days = (Date.parse(row.subscription_expires_at) - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 29.9 && days <= 30, `expires in ${days} days`);
  assert.equal(row.payment_pending_at, null);

  const groqBefore = groqCalls.length;
  for (let i = 0; i < 4; i++) await useOneFreeRequest(151);
  assert.equal(groqCalls.length, groqBefore + 4, "subscribers are not limited");
});

test("only the admin chat can approve: anyone else pressing the button changes nothing", async () => {
  for (let i = 0; i < 3; i++) await useOneFreeRequest(161);
  say(161, MENU.TRANSLATE);
  await waitFor(() => lastTo(161).text === "متنی که می‌خوای ترجمه و ساده بشه رو بفرست 🌐\nهر زبانی باشه، به فارسی روان و ساده برات برمی‌گردونم.", "prompt");
  say(161, "one more");
  await waitFor(() => /سهمیه‌ی رایگان/.test(lastTo(161).text), "paywall");

  press(161, 161, "pay:approve:161"); // the user "approving" themselves
  await waitFor(() => bot.answers.at(-1) && bot.answers.at(-1).opts && bot.answers.at(-1).opts.show_alert === true, "refusal");
  assert.equal(emulator.rows.get(161).subscription_expires_at, null);
});

test("admin rejects: user told, and a corrected receipt still reaches the admin", async () => {
  for (let i = 0; i < 3; i++) await useOneFreeRequest(171);
  say(171, MENU.SUBSCRIBE);
  await waitFor(() => /شماره کارت/.test(lastTo(171).text), "subscription screen");

  press(999, 999, "pay:reject:171");
  await waitFor(() => /تایید نشد/.test(lastTo(171).text), "rejection notice");
  assert.match(lastTo(171).text, /@kooleh_admin/);

  const photosBefore = bot.photos.length;
  sendPhoto(171);
  await waitFor(() => bot.photos.length === photosBefore + 1, "resent receipt forwarded");
});

test("💳 shows price, the metro framing and card; the next photo is a receipt", async () => {
  say(181, MENU.SUBSCRIBE);
  await waitFor(() => countTo(181) === 1, "screen");
  const screen = lastTo(181);
  assert.match(screen.text, /۱۲۰٬۰۰۰ تومان در ماه/);
  assert.match(screen.text, /روزی کمتر از یه بلیط مترو/);
  assert.match(screen.text, /<code>6037-9911-2233-4455<\/code>/);

  const photosBefore = bot.photos.length;
  sendPhoto(181);
  await waitFor(() => bot.photos.length === photosBefore + 1, "receipt forwarded");
});

test("explicitly choosing 🗜 first means compress, even for a user with a payment pending", async () => {
  say(191, MENU.SUBSCRIBE); // pending now
  await waitFor(() => countTo(191) === 1, "screen");
  say(191, MENU.COMPRESS);
  await waitFor(() => countTo(191) === 2, "compress prompt");

  const photosBefore = bot.photos.length;
  sendPhoto(191);
  await waitFor(() => bot.documents.some((d) => d.chatId === 191), "compressed");
  assert.equal(bot.photos.length, photosBefore, "not forwarded to the admin");
});

// --- failed requests don't cost a free request ---------------------------------
test("a request that fails is refunded", async () => {
  const realFetch = globalThis.fetch;
  let failNext = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.groq.com") && failNext) {
      failNext = false;
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: { message: "boom" } }), text: async () => "" };
    }
    return realFetch(url, init);
  };
  try {
    say(201, MENU.TRANSLATE);
    await waitFor(() => countTo(201) === 1, "prompt");
    say(201, "text that will fail once");
    await waitFor(() => /مشکل مواجه شد/.test(lastTo(201).text), "error message");
    await waitFor(() => emulator.rows.get(201) && emulator.rows.get(201).weekly_request_count === 0, "refund");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- /status --------------------------------------------------------------------
test("/status answers the admin and ignores everyone else", async () => {
  const before = countTo(999);
  say(999, "/status");
  await waitFor(() => countTo(999) === before + 1, "status");
  assert.match(lastTo(999).text, /اتصال Supabase: سالم/);

  const other = countTo(301);
  say(301, "/status");
  await sleep(60);
  assert.equal(countTo(301), other);
});

// --- long PDFs: chunked map-reduce under the TPM budget ----------------------------
const sentences = (chars) => {
  const out = [];
  for (let i = 0; out.join("\n").length < chars; i++) out.push(`Sentence ${i} covers idea number ${i} in this long lecture document.`);
  return out.join("\n");
};

test("a long PDF is summarized in chunks (several Groq calls) and one summary is delivered", async () => {
  pdfTextValue = sentences(9000);
  const groqBefore = groqCalls.length;
  say(401, MENU.PDF);
  await waitFor(() => countTo(401) === 1, "prompt");
  sendPdf(401);
  await waitFor(() => lastTo(401).text === "نتیجه‌ی آزمایشی", "final summary");

  const calls = groqCalls.length - groqBefore;
  assert.ok(calls >= 4, `expected chunk calls plus a final merge, saw ${calls}`);

  // Every call stayed inside the per-request budget (nothing near the 6000 TPM cap).
  for (const body of groqCalls.slice(groqBefore)) {
    const inputChars = body.messages.reduce((n, m) => n + m.content.length, 0);
    assert.ok(inputChars / 1.6 + body.max_completion_tokens < 3000, "each request is sized well under the per-minute budget");
    assert.equal(body.reasoning_effort, "low", "gpt-oss reasoning is kept short on the tight budget");
  }

  // The last call is the final merge, and its input is partial summaries, not raw text.
  const last = groqCalls.at(-1);
  assert.match(last.messages[0].content, /خلاصه‌های پشت‌سرهم/);

  assert.ok(bot.edits.some((e) => /بخش ۱ از/.test(e.text)), "progress was shown");
  assert.ok(bot.deleted.some((d) => d.chatId === 401), "the progress message was cleaned up");
  assert.equal(emulator.rows.get(401).weekly_request_count, 1, "one request counted");
});

test("a PDF over the length cap gets the friendly message and costs nothing", async () => {
  pdfTextValue = sentences(45000);
  const groqBefore = groqCalls.length;
  say(402, MENU.PDF);
  await waitFor(() => countTo(402) === 1, "prompt");
  sendPdf(402);
  await waitFor(() => /خیلی طولانیه/.test(lastTo(402).text), "too-long message");
  assert.equal(groqCalls.length, groqBefore);
  await waitFor(() => emulator.rows.get(402).weekly_request_count === 0, "refund");
});

test("a scanned PDF (no text layer) gets the friendly message and costs nothing", async () => {
  pdfTextValue = "";
  say(403, MENU.PDF);
  await waitFor(() => countTo(403) === 1, "prompt");
  sendPdf(403);
  await waitFor(() => /اسکن‌شده/.test(lastTo(403).text), "no-text message");
  await waitFor(() => emulator.rows.get(403).weekly_request_count === 0, "refund");
  pdfTextValue = PDF_TEXT;
});

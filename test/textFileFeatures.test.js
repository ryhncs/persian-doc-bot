// End-to-end for the three new "convert to text/file" menu buttons: the real
// src/bot.js, handlers, usage service and supabaseStore, with only the outside
// world faked: Telegram (an EventEmitter bot), Supabase (the strict PostgREST
// emulator), Groq, file downloads, the transcriber and the PDF text extractor.
// Every Groq call is counted so each feature's "no LLM/no summarization" claim
// is checked behaviorally, not just by reading the code.

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
process.env.TTS_ENABLED = "";
process.env.SUBSCRIBER_AUDIO_PER_DAY = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createPostgrestEmulator } = require("./postgrestEmulator");

// --- fake node-telegram-bot-api ------------------------------------------------
class FakeBot extends EventEmitter {
  constructor() {
    super();
    FakeBot.instance = this;
    this.sent = [];
    this.documents = [];
    this.answers = [];
    this.deleted = [];
  }
  onText(regex, cb) {
    this.on("message", (msg) => {
      if (typeof msg.text !== "string") return;
      const match = msg.text.match(regex);
      if (match) cb(msg, match);
    });
  }
  async getMe() {
    return { username: "kooleh_test_bot" };
  }
  async sendMessage(chatId, text, opts) {
    this.sent.push({ chatId, text, opts });
    return { message_id: this.sent.length };
  }
  async sendChatAction() {}
  async sendDocument(chatId, buffer, opts, fileOpts) {
    this.documents.push({ chatId, buffer, opts, fileOpts });
  }
  async sendPhoto() {}
  async sendVoice() {}
  async answerCallbackQuery(id, opts) {
    this.answers.push({ id, opts });
  }
  async editMessageText() {}
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

// --- fakes for the PDF text extractor and the transcriber ----------------------------
const pdf = { text: "A short lecture note about gradient descent and learning rates.", fail: null };
const transcribe = { text: "این یک پیام صوتی آزمایشی درباره‌ی درس آمار است.", fail: null };
for (const [file, exports] of [
  [
    "../src/services/pdfText",
    {
      extractPdfText: async () => {
        if (pdf.fail) throw pdf.fail;
        return { text: pdf.text, numPages: 1 };
      },
    },
  ],
  ["../src/services/pdfCompress", { compressPdf: async () => Buffer.from("tiny-pdf") }],
  [
    "../src/services/transcribe",
    {
      transcribeAudio: async () => {
        if (transcribe.fail) throw transcribe.fail;
        return transcribe.text;
      },
    },
  ],
]) {
  const resolved = require.resolve(file);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// --- fake network -----------------------------------------------------------------------
const emulator = createPostgrestEmulator();
const groqCalls = []; // every Groq HTTP call, regardless of endpoint — proves "no LLM call" claims

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://supabase.test")) return emulator.handle(u, init);
  if (u.includes("api.groq.com")) {
    groqCalls.push({ url: u, body: init.body });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: "نتیجه‌ی آزمایشی" }, finish_reason: "stop" }], usage: { total_tokens: 20 } }),
      text: async () => "",
    };
  }
  if (u.startsWith("http://tg.test/file/")) {
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("fake-file-bytes").buffer };
  }
  throw new Error(`unexpected fetch: ${u}`);
};

require("../src/bot");
const bot = FakeBot.instance;
const config = require("../src/config");
const { MENU } = require("../src/handlers/menu");
config.GLOBAL_LLM_PER_MINUTE = 1e9;
config.GLOBAL_WHISPER_PER_MINUTE = 1e9;

// --- helpers ----------------------------------------------------------------------------------
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
const sendVoice = (id, duration = 12) => bot.emit("voice", { chat: { id }, from: user(id), voice: { file_id: "voice-1", duration, file_size: 5000 } });
const sendPdf = (id, name = "notes.pdf") =>
  bot.emit("document", { chat: { id }, from: user(id), document: { file_id: "doc-1", file_name: name, mime_type: "application/pdf", file_size: 1000 } });
let cbSeq = 0;
function tap(fromId, chatId, data) {
  const id = `cb-${++cbSeq}`;
  bot.emit("callback_query", { id, from: { id: fromId }, message: { chat: { id: chatId }, message_id: 5 }, data });
  return id;
}
const answerFor = (cbId) => bot.answers.find((a) => a.id === cbId);
const lastTo = (id) => bot.messagesTo(id).at(-1);
const countTo = (id) => bot.messagesTo(id).length;
const docsTo = (id) => bot.documents.filter((d) => d.chatId === id);
const row = (id) => emulator.rows.get(id);
const isDocx = (buf) => buf.slice(0, 2).toString() === "PK"; // .docx is a ZIP container

async function tapMenu(id, label) {
  const before = countTo(id);
  say(id, label);
  await waitFor(() => countTo(id) === before + 1, `${label} prompt`);
}

test.before(async () => {
  await waitFor(() => emulator.requests.length > 0, "startup probe");
  await sleep(20); // let getMe resolve
});

// =====================================================================================
// 🎙 تبدیل صدا به متن (voice to text, no summary)
// =====================================================================================
test("🎙 تبدیل صدا به متن sends the raw transcript verbatim, with no summarization and no LLM call", async () => {
  await tapMenu(601, MENU.VOICE_TO_TEXT);
  const groqBefore = groqCalls.length;
  sendVoice(601);
  await waitFor(() => lastTo(601) && lastTo(601).text === transcribe.text, "raw transcript delivered");

  assert.equal(groqCalls.length, groqBefore, "no Groq call at all — no summarization happened");
  assert.equal(countTo(601), 3, "prompt + processing message + the transcript");
  assert.equal(row(601).weekly_request_count, 1, "counted as one billable request");

  const keyboard = lastTo(601).opts.reply_markup.inline_keyboard;
  assert.equal(keyboard[0][0].text, "خروجی Word");
  assert.match(keyboard[0][0].callback_data, /^vs:docxfull:[0-9a-f]+$/);
});

test("a long transcript is split across messages, and the Word button is only under the last one", async () => {
  transcribe.text = "جمله‌ی آزمایشی برای طولانی کردن رونوشت. ".repeat(150); // well over 4096 chars
  try {
    await tapMenu(602, MENU.VOICE_TO_TEXT);
    const before = countTo(602);
    sendVoice(602);
    await waitFor(() => countTo(602) > before + 1, "more than one chunk sent");

    const chunks = bot.messagesTo(602).slice(before + 1); // skip the "⏳ ..." processing message
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
    const rejoined = chunks.map((c) => c.text).join("");
    assert.ok(rejoined.replace(/\s+/g, " ").includes("جمله‌ی آزمایشی"), "no content was lost");
    for (const c of chunks.slice(0, -1)) assert.equal(c.opts, undefined, "no button on earlier chunks");
    assert.ok(chunks.at(-1).opts.reply_markup.inline_keyboard[0][0].text === "خروجی Word");
  } finally {
    transcribe.text = "این یک پیام صوتی آزمایشی درباره‌ی درس آمار است.";
  }
});

test("the Word button under a raw transcript delivers a real .docx via the existing session/callback mechanism", async () => {
  await tapMenu(603, MENU.VOICE_TO_TEXT);
  sendVoice(603);
  await waitFor(() => lastTo(603) && lastTo(603).opts, "transcript with button");

  const data = lastTo(603).opts.reply_markup.inline_keyboard[0][0].callback_data;
  const docsBefore = docsTo(603).length;
  tap(603, 603, data);
  await waitFor(() => docsTo(603).length === docsBefore + 1, "docx delivered");

  const doc = docsTo(603).at(-1);
  assert.equal(doc.fileOpts.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.ok(isDocx(doc.buffer), "a real docx (zip) was produced");
});

test("too short/too long voice messages are still rejected (unchanged), and nothing is billed", async () => {
  await tapMenu(604, MENU.VOICE_TO_TEXT);
  const before = countTo(604);
  sendVoice(604, 2); // below MIN_VOICE_DURATION_SECONDS
  await waitFor(() => countTo(604) === before + 1, "too-short message");
  assert.match(lastTo(604).text, /کوتاهه/);
  assert.equal(row(604), undefined, "nothing billed");
});

test("if transcription fails the user is told and the request is refunded", async () => {
  await tapMenu(605, MENU.VOICE_TO_TEXT);
  transcribe.fail = new Error("Whisper exploded");
  try {
    const before = countTo(605);
    sendVoice(605);
    await waitFor(() => countTo(605) === before + 2, "processing + error message");
    assert.match(lastTo(605).text, /مشکلی پیش اومد/);
  } finally {
    transcribe.fail = null;
  }
  await waitFor(() => row(605).weekly_request_count === 0, "refund");
});

test("a voice message with no menu tap is still summarized as before (unchanged default behavior)", async () => {
  const groqBefore = groqCalls.length;
  sendVoice(606);
  await waitFor(() => groqCalls.length > groqBefore, "the summarizer called Groq");
  await waitFor(() => lastTo(606) && lastTo(606).text === "نتیجه‌ی آزمایشی", "summary delivered");
  assert.ok(lastTo(606).opts.reply_markup.inline_keyboard[0].some((b) => b.text === "متن کامل"), "the usual summary buttons are there");
});

test("voice-to-text qualifies an invited user's first request for the referral bonus", async () => {
  await tapMenu(700, "🎁 دعوت دوستان");
  const code = /start=ref_([A-Z0-9]{8})/.exec(lastTo(700).text)[1];
  say(701, `/start ref_${code}`);
  await waitFor(() => countTo(701) === 2, "attribution");

  await tapMenu(701, MENU.VOICE_TO_TEXT);
  sendVoice(701);
  await waitFor(() => row(701) && row(701).bonus_requests === 2 && row(700).bonus_requests === 2, "both bonuses paid");
});

// =====================================================================================
// 📄 تبدیل متن PDF به متن (PDF to text, always as Word, no summary)
// =====================================================================================
test("📄 تبدیل متن PDF به متن sends a Word file with the full extracted text, no LLM call", async () => {
  await tapMenu(610, MENU.PDF_TO_TEXT);
  const groqBefore = groqCalls.length;
  const docsBefore = docsTo(610).length;
  sendPdf(610, "jozve.pdf");
  await waitFor(() => docsTo(610).length === docsBefore + 1, "docx delivered");

  assert.equal(groqCalls.length, groqBefore, "no Groq call at all — no summarization happened");
  const doc = docsTo(610).at(-1);
  assert.equal(doc.fileOpts.filename, "jozve.docx");
  assert.equal(doc.fileOpts.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.ok(isDocx(doc.buffer));
  assert.equal(row(610).weekly_request_count, 1, "counted as one billable request");
});

test("a scanned PDF (no text layer) gets the friendly message and costs nothing", async () => {
  pdf.text = "";
  try {
    await tapMenu(611, MENU.PDF_TO_TEXT);
    const before = countTo(611);
    sendPdf(611);
    await waitFor(() => countTo(611) === before + 2, "processing + no-text-layer message");
    assert.match(lastTo(611).text, /اسکن‌شده/);
  } finally {
    pdf.text = "A short lecture note about gradient descent and learning rates.";
  }
  await waitFor(() => row(611).weekly_request_count === 0, "refund");
});

test("if extraction fails the user is told and the request is refunded", async () => {
  await tapMenu(612, MENU.PDF_TO_TEXT);
  pdf.fail = new Error("pdf-parse exploded");
  try {
    const before = countTo(612);
    sendPdf(612);
    await waitFor(() => countTo(612) === before + 2, "processing + error message");
    assert.match(lastTo(612).text, /با مشکل مواجه شد/);
  } finally {
    pdf.fail = null;
  }
  await waitFor(() => row(612).weekly_request_count === 0, "refund");
});

test("a PDF with no menu tap still asks summarize-or-compress (unchanged default), never text-to-Word", async () => {
  const before = countTo(613);
  sendPdf(613);
  await waitFor(() => countTo(613) === before + 1, "choice screen");
  const buttons = lastTo(613).opts.reply_markup.inline_keyboard[0];
  assert.deepEqual(buttons.map((b) => b.text), ["📝 خلاصه‌سازی", "🗜 کم کردن حجم"]);
});

test("PDF-to-text qualifies an invited user's first request for the referral bonus", async () => {
  await tapMenu(710, "🎁 دعوت دوستان");
  const code = /start=ref_([A-Z0-9]{8})/.exec(lastTo(710).text)[1];
  say(711, `/start ref_${code}`);
  await waitFor(() => countTo(711) === 2, "attribution");

  await tapMenu(711, MENU.PDF_TO_TEXT);
  sendPdf(711);
  await waitFor(() => row(711) && row(711).bonus_requests === 2 && row(710).bonus_requests === 2, "both bonuses paid");
});

// =====================================================================================
// 📝 تبدیل متن به فایل (text to file — Word only for now)
// =====================================================================================
test("📝 تبدیل متن به فایل sends the text back as a Word file directly, no format-choice screen, no LLM call", async () => {
  await tapMenu(620, MENU.TEXT_TO_FILE);
  const groqBefore = groqCalls.length;
  const docsBefore = docsTo(620).length;
  say(620, "این یک متن آزمایشی است که باید به فایل ورد تبدیل شود.");
  await waitFor(() => docsTo(620).length === docsBefore + 1, "docx delivered");

  assert.equal(groqCalls.length, groqBefore, "no Groq call at all");
  const doc = docsTo(620).at(-1);
  assert.equal(doc.fileOpts.filename, "document.docx");
  assert.equal(doc.fileOpts.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.ok(isDocx(doc.buffer));
  assert.equal(row(620).weekly_request_count, 1, "counted as one billable request");
  // No intermediate "Word or PDF?" screen — the file is the direct reply.
  assert.ok(!bot.messagesTo(620).some((m) => m.opts && m.opts.reply_markup), "no choice buttons were shown");
});

test("if delivering the file fails (e.g. a Telegram API error) the user is told and the request is refunded", async () => {
  await tapMenu(621, MENU.TEXT_TO_FILE);
  const originalSendDocument = bot.sendDocument.bind(bot);
  bot.sendDocument = async () => {
    throw new Error("Telegram sendDocument failed");
  };
  try {
    const before = countTo(621);
    say(621, "متنی که باید شکست بخورد.");
    await waitFor(() => countTo(621) === before + 2, "processing + error message");
    assert.match(lastTo(621).text, /با مشکل مواجه شد/);
  } finally {
    bot.sendDocument = originalSendDocument;
  }
  await waitFor(() => row(621).weekly_request_count === 0, "refund");
});

test("the tap is one-shot, and plain text with no menu tap still uses the existing FREE Word-export flow (unchanged)", async () => {
  await tapMenu(622, MENU.TEXT_TO_FILE);
  const billedBefore = row(622) ? row(622).weekly_request_count : 0;
  say(622, "متن اول که باید فایل بشه.");
  await waitFor(() => docsTo(622).length === 1, "billed export");
  assert.equal(row(622).weekly_request_count, billedBefore + 1);

  const before = row(622).weekly_request_count;
  say(622, "متن دوم، بدون تپ منو دوباره.");
  await waitFor(() => docsTo(622).length === 2, "free export");
  assert.equal(row(622).weekly_request_count, before, "the free default flow did not charge anything");
  assert.equal(docsTo(622).at(-1).fileOpts.filename, "document.docx");
});

test("text-to-file qualifies an invited user's first request for the referral bonus", async () => {
  await tapMenu(720, "🎁 دعوت دوستان");
  const code = /start=ref_([A-Z0-9]{8})/.exec(lastTo(720).text)[1];
  say(721, `/start ref_${code}`);
  await waitFor(() => countTo(721) === 2, "attribution");

  await tapMenu(721, MENU.TEXT_TO_FILE);
  say(721, "اولین درخواست من تبدیل متن به فایل است.");
  await waitFor(() => row(721) && row(721).bonus_requests === 2 && row(720).bonus_requests === 2, "both bonuses paid");
});

// =====================================================================================
// The weekly free-tier limit applies identically to all three new features
// =====================================================================================
test("3 free requests a week apply across the new features too, then the paywall", async () => {
  await tapMenu(630, MENU.TEXT_TO_FILE);
  say(630, "درخواست اول.");
  await waitFor(() => docsTo(630).length === 1, "first");

  await tapMenu(630, MENU.PDF_TO_TEXT);
  sendPdf(630);
  await waitFor(() => docsTo(630).length === 2, "second");

  await tapMenu(630, MENU.VOICE_TO_TEXT);
  sendVoice(630);
  await waitFor(() => bot.messagesTo(630).some((m) => m.text === transcribe.text), "third");
  assert.equal(row(630).weekly_request_count, 3);

  await tapMenu(630, MENU.TEXT_TO_FILE);
  const before = countTo(630);
  say(630, "درخواست چهارم که باید بلاک بشه.");
  await waitFor(() => countTo(630) === before + 1, "paywall");
  assert.match(lastTo(630).text, /سهمیه‌ی رایگان/);
});

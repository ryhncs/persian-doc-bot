// End-to-end for the audio version of summaries and the referral/coupon system:
// the real src/bot.js, handlers, usage service, referral service and
// supabaseStore, with only the outside world faked: Telegram (an EventEmitter
// bot), Supabase (the strict PostgREST emulator), Groq, file downloads, the
// transcriber, the PDF helpers, and the Edge TTS synthesizer.

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
const sharp = require("sharp");

const { createPostgrestEmulator } = require("./postgrestEmulator");

// --- fake node-telegram-bot-api ------------------------------------------------
class FakeBot extends EventEmitter {
  constructor() {
    super();
    FakeBot.instance = this;
    this.sent = [];
    this.documents = [];
    this.photos = [];
    this.voices = [];
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
  async sendPhoto(chatId, photo, opts) {
    this.photos.push({ chatId, photo, opts });
  }
  async sendVoice(chatId, buffer, opts, fileOpts) {
    this.voices.push({ chatId, buffer, opts, fileOpts });
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

// --- fakes for pdf helpers, the transcriber and the TTS synthesizer ---------------------
const realTts = require("../src/services/tts"); // keep the real text preparation; only synthesis is faked
const tts = { calls: [], fail: false, gate: null };
for (const [file, exports] of [
  ["../src/services/pdfText", { extractPdfText: async () => ({ text: "A short lecture note about gradient descent and learning rates.", numPages: 1 }) }],
  ["../src/services/pdfCompress", { compressPdf: async () => Buffer.from("tiny-pdf") }],
  ["../src/services/transcribe", { transcribeAudio: async () => "این یک پیام صوتی آزمایشی درباره‌ی درس آمار است." }],
  [
    "../src/services/tts",
    {
      ...realTts,
      synthesizeSpeech: async (text) => {
        tts.calls.push(text);
        if (tts.gate) await tts.gate;
        if (tts.fail) throw new Error("Edge endpoint blocked");
        return Buffer.from("OggS-fake-opus-audio");
      },
    },
  ],
]) {
  const resolved = require.resolve(file);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// --- fake network -----------------------------------------------------------------------
const emulator = createPostgrestEmulator();
const net = { dbDown: false, groqFails: 0 };
let jpeg;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://supabase.test")) {
    if (net.dbDown) {
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
    if (net.groqFails > 0) {
      net.groqFails -= 1;
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: { message: "boom" } }), text: async () => "boom" };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: "نتیجه‌ی آزمایشی" }, finish_reason: "stop" }], usage: { total_tokens: 20 } }),
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
const config = require("../src/config");
const { MENU } = require("../src/handlers/menu");
const { audioButtonRows } = require("../src/handlers/audioVersion");
// This file makes far more LLM calls per minute than the bot-wide politeness cap allows.
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
const photoMsg = (id) => ({ chat: { id }, from: user(id), photo: [{ file_id: "photo-small" }, { file_id: "photo-large" }] });
function sendPhoto(id) {
  bot.emit("message", photoMsg(id));
  bot.emit("photo", photoMsg(id));
}
const sendPdf = (id) =>
  bot.emit("document", { chat: { id }, from: user(id), document: { file_id: "doc-1", file_name: "notes.pdf", mime_type: "application/pdf", file_size: 1000 } });
const sendVoice = (id) => bot.emit("voice", { chat: { id }, from: user(id), voice: { file_id: "voice-1", duration: 12, file_size: 5000 } });
let cbSeq = 0;
function tap(fromId, chatId, data) {
  const id = `cb-${++cbSeq}`;
  bot.emit("callback_query", { id, from: { id: fromId }, message: { chat: { id: chatId }, message_id: 5, caption: "receipt" }, data });
  return id;
}
const answerFor = (cbId) => bot.answers.find((a) => a.id === cbId);
const lastTo = (id) => bot.messagesTo(id).at(-1);
const countTo = (id) => bot.messagesTo(id).length;
const row = (id) => emulator.rows.get(id);
const SUMMARY = "نتیجه‌ی آزمایشی";

// A PDF summary for `id` (one billable request); resolves the callback data of its buttons.
async function pdfSummary(id) {
  const before = countTo(id);
  say(id, MENU.PDF);
  await waitFor(() => countTo(id) === before + 1, "pdf prompt");
  sendPdf(id);
  await waitFor(() => lastTo(id).text === SUMMARY && lastTo(id).opts && lastTo(id).opts.reply_markup, "summary with buttons");
  return lastTo(id).opts.reply_markup.inline_keyboard;
}
const audioData = (keyboard) => keyboard[1][0].callback_data;

// A billable translation for `id`.
async function translate(id) {
  const before = countTo(id);
  say(id, MENU.TRANSLATE);
  await waitFor(() => countTo(id) === before + 1, "translate prompt");
  say(id, "Some text to translate.");
  // (a referral notice may follow the result, so wait for at least these three)
  await waitFor(() => countTo(id) >= before + 3, "translation result");
}
// Waits for the "bonus paid" notice to the invitee, so message counts are stable afterwards.
const invitedNotice = (id) => waitFor(() => bot.messagesTo(id).some((m) => /چون با دعوت یکی از دوستانت وارد کوله شدی/.test(m.text)), "invitee notice");

test.before(async () => {
  jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg({ quality: 95 }).toBuffer();
  await waitFor(() => emulator.requests.length > 0, "startup probe");
  await sleep(20); // let getMe resolve
});

// =====================================================================================
// Audio version
// =====================================================================================
test("a voice summary carries a 🔊 button as a second row and no audio is made until it is tapped", async () => {
  const ttsBefore = tts.calls.length;
  sendVoice(601);
  await waitFor(() => lastTo(601) && lastTo(601).text === SUMMARY && lastTo(601).opts, "voice summary");

  const keyboard = lastTo(601).opts.reply_markup.inline_keyboard;
  assert.deepEqual(keyboard[0].map((b) => b.text), ["متن کامل", "خروجی Word"], "existing buttons unchanged");
  assert.equal(keyboard[1].length, 1);
  assert.equal(keyboard[1][0].text, "🔊 دریافت نسخه صوتی");
  assert.match(keyboard[1][0].callback_data, /^vs:tts:[0-9a-f]+$/);
  assert.equal(tts.calls.length, ttsBefore, "opt-in: nothing synthesized yet");
  assert.equal(bot.voices.filter((v) => v.chatId === 601).length, 0);
  assert.equal(row(601).weekly_request_count, 1, "only the summary was counted");
});

test("a PDF summary carries the 🔊 button too", async () => {
  const keyboard = await pdfSummary(602);
  assert.equal(keyboard[1][0].text, "🔊 دریافت نسخه صوتی");
});

test("tapping 🔊 sends the same summary as a voice message and counts as one more request", async () => {
  const keyboard = await pdfSummary(610);
  assert.equal(row(610).weekly_request_count, 1);

  const cb = tap(610, 610, audioData(keyboard));
  await waitFor(() => bot.voices.some((v) => v.chatId === 610), "voice message");

  const voice = bot.voices.find((v) => v.chatId === 610);
  assert.equal(voice.fileOpts.contentType, "audio/ogg");
  assert.equal(voice.buffer.toString(), "OggS-fake-opus-audio");
  assert.equal(tts.calls.at(-1), SUMMARY, "the summary text is what is spoken");
  assert.equal(row(610).weekly_request_count, 2, "audio = one additional billable request");
  assert.ok(answerFor(cb), "the tap was acknowledged");
});

test("every repeated tap charges again, and the 3-per-week limit applies (paywall on the 4th billable action)", async () => {
  const keyboard = await pdfSummary(620); // 1
  const data = audioData(keyboard);

  tap(620, 620, data); // 2
  await waitFor(() => bot.voices.filter((v) => v.chatId === 620).length === 1, "first audio");
  tap(620, 620, data); // 3
  await waitFor(() => bot.voices.filter((v) => v.chatId === 620).length === 2, "second audio");
  assert.equal(row(620).weekly_request_count, 3);

  const ttsBefore = tts.calls.length;
  const before = countTo(620);
  tap(620, 620, data); // 4: over the limit
  await waitFor(() => countTo(620) === before + 1, "paywall");
  assert.match(lastTo(620).text, /سهمیه‌ی رایگان/);
  assert.equal(bot.voices.filter((v) => v.chatId === 620).length, 2, "no audio for the blocked tap");
  assert.equal(tts.calls.length, ttsBefore, "the synthesizer was not even called");
  assert.equal(row(620).weekly_request_count, 3);
});

test("if audio can't be made the user is told and the request is refunded", async () => {
  const keyboard = await pdfSummary(630);
  assert.equal(row(630).weekly_request_count, 1);

  tts.fail = true;
  const before = countTo(630);
  tap(630, 630, audioData(keyboard));
  await waitFor(() => countTo(630) === before + 1, "error message");
  tts.fail = false;

  assert.match(lastTo(630).text, /ساخت نسخه صوتی با مشکل مواجه شد/);
  assert.equal(bot.voices.filter((v) => v.chatId === 630).length, 0);
  await waitFor(() => row(630).weekly_request_count === 1, "refund");
});

test("only the owner can use the button, and an expired session says so; neither costs anything", async () => {
  const keyboard = await pdfSummary(640);
  const callsBefore = tts.calls.length;

  const stranger = tap(641, 641, audioData(keyboard));
  await waitFor(() => answerFor(stranger), "answer to stranger");
  assert.equal(answerFor(stranger).opts.show_alert, true);

  const expired = tap(640, 640, "vs:tts:deadbeef00");
  await waitFor(() => answerFor(expired), "answer for expired");
  assert.match(answerFor(expired).opts.text, /منقضی/);

  assert.equal(tts.calls.length, callsBefore);
  assert.equal(row(640).weekly_request_count, 1);
});

test("a second tap while audio is still being made is refused (no double work, no double charge)", async () => {
  const keyboard = await pdfSummary(650);
  let release;
  tts.gate = new Promise((resolve) => (release = resolve));

  tap(650, 650, audioData(keyboard));
  await waitFor(() => tts.calls.length > 0 && row(650).weekly_request_count === 2, "first conversion running");
  const second = tap(650, 650, audioData(keyboard));
  await waitFor(() => answerFor(second), "busy answer");
  assert.equal(answerFor(second).opts.show_alert, true);
  assert.equal(row(650).weekly_request_count, 2, "the refused tap cost nothing");

  tts.gate = null;
  release();
  await waitFor(() => bot.voices.some((v) => v.chatId === 650), "audio delivered");
  assert.equal(bot.voices.filter((v) => v.chatId === 650).length, 1);
});

test("subscribers: unlimited requests, but at most 15 audio versions per day", async () => {
  const keyboard = await pdfSummary(660);
  row(660).subscription_expires_at = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const data = audioData(keyboard);

  for (let i = 1; i <= 15; i++) {
    tap(660, 660, data);
    await waitFor(() => bot.voices.filter((v) => v.chatId === 660).length === i, `audio #${i}`);
  }
  assert.equal(row(660).weekly_request_count, 1, "subscribers' audio never touches the weekly counter");

  const sixteenth = tap(660, 660, data);
  await waitFor(() => answerFor(sixteenth), "cap answer");
  assert.equal(answerFor(sixteenth).opts.show_alert, true);
  assert.match(answerFor(sixteenth).opts.text, /۱۵/);
  assert.equal(bot.voices.filter((v) => v.chatId === 660).length, 15, "no 16th audio");
});

test("TTS can be switched off: no button under summaries", () => {
  const original = config.TTS_ENABLED;
  try {
    config.TTS_ENABLED = false;
    assert.deepEqual(audioButtonRows("abc"), []);
    config.TTS_ENABLED = true;
    assert.equal(audioButtonRows("abc")[0][0].text, "🔊 دریافت نسخه صوتی");
  } finally {
    config.TTS_ENABLED = original;
  }
});

// =====================================================================================
// Referrals
// =====================================================================================
async function inviteCodeOf(id) {
  const before = countTo(id);
  say(id, "/invite");
  await waitFor(() => countTo(id) === before + 1, "invite screen");
  const match = /start=ref_([A-Z0-9]{8})/.exec(lastTo(id).text);
  assert.ok(match, "invite link in the message");
  return match[1];
}

test("🎁 دعوت دوستان and /invite show the link, the rules and the user's status", async () => {
  say(700, MENU.INVITE);
  await waitFor(() => countTo(700) === 1, "invite screen via menu");
  const screen = lastTo(700);
  assert.match(screen.text, /https:\/\/t\.me\/kooleh_test_bot\?start=ref_[A-Z2-9]{8}/, "uses the username from getMe");
  assert.match(screen.text, /۲ درخواست رایگان اضافه/);
  assert.match(screen.text, /هر ۳ دعوت موفق/);
  assert.match(screen.text, /دعوت موفق: ۰/);
  assert.match(screen.text, /کوپن‌های آماده: ۰/);
  assert.match(screen.opts.reply_markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\/share\/url\?url=/);

  const code = await inviteCodeOf(700);
  assert.equal(row(700).referral_code, code, "same code every time");
});

test("the welcome text and menu are unchanged for a deep-link start; the user is told what the invite does", async () => {
  const code = await inviteCodeOf(701);
  say(702, `/start ref_${code}`);
  await waitFor(() => countTo(702) === 2, "welcome + invite note");
  assert.match(bot.messagesTo(702)[0].text, /^سلام! به کوله خوش اومدی/);
  assert.equal(bot.messagesTo(702)[0].opts.reply_markup.is_persistent, true);
  assert.match(lastTo(702).text, /با دعوت یکی از دوستانت اومدی/);
  assert.equal(row(702).referred_by, 701);
  assert.equal(row(702).bonus_requests, 0, "starting the bot pays nothing");
  assert.equal(row(701).bonus_requests, 0);
});

test("the bonus is paid, and both sides told, only after the invitee's first billable request is delivered", async () => {
  const code = await inviteCodeOf(710);
  say(711, `/start ref_${code}`);
  await waitFor(() => countTo(711) === 2, "invite attribution");

  await translate(711);
  await waitFor(() => row(711).bonus_requests === 2 && row(710).bonus_requests === 2, "both bonuses");

  await waitFor(() => bot.messagesTo(711).some((m) => /چون با دعوت یکی از دوستانت وارد کوله شدی/.test(m.text)), "invitee told");
  await waitFor(() => bot.messagesTo(710).some((m) => /یکی از دوستانت با لینک تو اولین درخواستش رو انجام داد/.test(m.text)), "inviter told");
  assert.equal(row(710).successful_referrals, 1);
  assert.match(bot.messagesTo(710).at(-1).text, /تا کوپن بعدی: ۲ دعوت موفق دیگه/);

  await translate(711); // further requests pay nothing more
  await sleep(50);
  assert.equal(row(711).bonus_requests, 2);
  assert.equal(row(710).bonus_requests, 2);
  assert.equal(row(710).successful_referrals, 1);
});

test("compression is free, so it does not qualify a referral", async () => {
  const code = await inviteCodeOf(720);
  say(721, `/start ref_${code}`);
  await waitFor(() => countTo(721) === 2, "attribution");

  const docsBefore = bot.documents.length;
  sendPhoto(721);
  await waitFor(() => bot.documents.length === docsBefore + 1, "image compressed");
  await sleep(50);
  assert.equal(row(721).first_action_at, null);
  assert.equal(row(721).bonus_requests, 0);
  assert.equal(row(720).bonus_requests, 0);
  assert.equal(row(720).successful_referrals, 0);

  await translate(721); // a real billable action does
  await waitFor(() => row(720).successful_referrals === 1, "qualified by a real request");
});

test("a request that fails (and is refunded) does not qualify a referral", async () => {
  const code = await inviteCodeOf(730);
  say(731, `/start ref_${code}`);
  await waitFor(() => countTo(731) === 2, "attribution");

  net.groqFails = 1;
  const before = countTo(731);
  say(731, MENU.TRANSLATE);
  await waitFor(() => countTo(731) === before + 1, "prompt");
  say(731, "Text that will fail.");
  await waitFor(() => bot.messagesTo(731).some((m) => /با مشکل مواجه شد/.test(m.text)), "error shown");
  await sleep(50);
  assert.equal(row(731).first_action_at, null);
  assert.equal(row(730).successful_referrals, 0);
  await waitFor(() => row(731).weekly_request_count === 0, "refund");
});

test("your own link, and a link opened by someone who already used the bot, are politely refused", async () => {
  const code = await inviteCodeOf(740);
  say(740, `/start ref_${code}`);
  await waitFor(() => bot.messagesTo(740).some((m) => /لینک دعوت خودته/.test(m.text)), "self link refused");

  await translate(741); // 741 is already an active user
  say(741, `/start ref_${code}`);
  await waitFor(() => bot.messagesTo(741).some((m) => /فقط برای کاربرهای جدید/.test(m.text)), "existing user refused");
  assert.equal(row(741).referred_by, null);
  assert.equal(row(740).successful_referrals, 0);
});

test("a nonsense or unknown invite payload is ignored and /start still works", async () => {
  say(750, "/start ref_ZZZZZZZZ");
  say(751, "/start whatever");
  await waitFor(() => countTo(750) >= 1 && countTo(751) >= 1, "welcomes");
  await sleep(50);
  assert.match(bot.messagesTo(750)[0].text, /^سلام! به کوله خوش اومدی/);
  assert.equal(countTo(750), 1, "no invite note for an unknown code");
  assert.equal(countTo(751), 1);
});

test("bonus requests are spent after the 3 weekly ones, then the paywall", async () => {
  const code = await inviteCodeOf(760);
  say(761, `/start ref_${code}`);
  await waitFor(() => countTo(761) === 2, "attribution");
  await translate(761); // 761: 1 weekly used; qualification gives 761 and 760 +2 each
  await waitFor(() => row(761).bonus_requests === 2, "bonus");
  await invitedNotice(761);

  await translate(761); // 2
  await translate(761); // 3 (weekly exhausted)
  assert.equal(row(761).weekly_request_count, 3);
  await translate(761); // bonus 1
  await translate(761); // bonus 2
  assert.equal(row(761).bonus_requests, 0);

  const before = countTo(761);
  say(761, MENU.TRANSLATE);
  await waitFor(() => countTo(761) === before + 1, "prompt");
  say(761, "One too many.");
  await waitFor(() => countTo(761) === before + 2, "paywall");
  assert.match(lastTo(761).text, /سهمیه‌ی رایگان/);
});

// --- coupons, end to end ---------------------------------------------------------------------
test("3 successful referrals earn a coupon; the payment screen shows the 20% price; approving redeems it", async () => {
  const code = await inviteCodeOf(800);
  for (const id of [801, 802, 803]) {
    say(id, `/start ref_${code}`);
    await waitFor(() => countTo(id) === 2, `attribution ${id}`);
    await translate(id);
    await waitFor(() => row(800).successful_referrals === [801, 802, 803].indexOf(id) + 1, `referral ${id} counted`);
  }
  assert.equal(row(800).coupons_available, 1);
  await waitFor(() => bot.messagesTo(800).some((m) => /🎟 یه کوپن ۲۰٪ تخفیف اشتراک هم گرفتی/.test(m.text)), "coupon message");

  // 💳 screen: discounted price, and the referral line.
  say(800, MENU.SUBSCRIBE);
  await waitFor(() => bot.messagesTo(800).some((m) => /🎟 کوپن تخفیف ۲۰٪ داری/.test(m.text)), "discount shown");
  const screen = bot.messagesTo(800).find((m) => /🎟 کوپن تخفیف ۲۰٪ داری/.test(m.text)).text;
  assert.match(screen, /۹۶٬۰۰۰ تومان/);
  assert.match(screen, /۱۲۰٬۰۰۰ تومان در ماه/, "the full price is still stated plainly");
  assert.doesNotMatch(screen, /مترو|بلیط/);

  // Receipt: the admin sees the discounted amount, and the approve button carries the coupon flag.
  const photosBefore = bot.photos.length;
  sendPhoto(800);
  await waitFor(() => bot.photos.length === photosBefore + 1, "receipt forwarded");
  const receipt = bot.photos.at(-1);
  assert.match(receipt.opts.caption, /۹۶٬۰۰۰ تومان/);
  assert.match(receipt.opts.caption, /با کوپن ۲۰٪ تخفیف/);
  assert.deepEqual(receipt.opts.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["pay:approve:800:d", "pay:reject:800"]);
  assert.equal(row(800).coupons_available, 1, "not redeemed until the admin approves");

  tap(999, 999, "pay:approve:800:d");
  await waitFor(() => row(800).coupons_redeemed === 1, "coupon redeemed");
  assert.equal(row(800).coupons_available, 0);
  assert.equal(row(800).successful_referrals, 3, "redeeming leaves the referral total untouched");
  assert.ok(Date.parse(row(800).subscription_expires_at) > Date.now());
  await waitFor(() => bot.messagesTo(800).some((m) => /کوپن تخفیفت روی این خرید استفاده شد/.test(m.text)), "user told");
  assert.ok(bot.edits.some((e) => e.caption && /یک کوپن تخفیف استفاده شد/.test(e.text)), "admin message notes the coupon");
});

test("without a coupon the approve button has no coupon flag and nothing is redeemed", async () => {
  say(811, MENU.SUBSCRIBE);
  await waitFor(() => countTo(811) === 1, "screen");
  assert.doesNotMatch(lastTo(811).text, /کوپن تخفیف ۲۰٪ داری/, "no coupon line for a user without a coupon");
  assert.match(lastTo(811).text, /💰 قیمت: ۱۲۰٬۰۰۰ تومان در ماه \(۳۰ روز\)/);

  const photosBefore = bot.photos.length;
  sendPhoto(811);
  await waitFor(() => bot.photos.length === photosBefore + 1, "receipt");
  assert.deepEqual(bot.photos.at(-1).opts.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["pay:approve:811", "pay:reject:811"]);
  assert.match(bot.photos.at(-1).opts.caption, /۱۲۰٬۰۰۰ تومان/);
});

test("a coupon flag on an approval when no coupon is left does not go negative, and tells the admin", async () => {
  await translate(820);
  tap(999, 999, "pay:approve:820:d");
  await waitFor(() => bot.edits.some((e) => e.caption && /کوپنی برای کسر نبود/.test(e.text)), "admin warned");
  assert.equal(row(820).coupons_available, 0);
  assert.equal(row(820).coupons_redeemed, 0);
  assert.ok(Date.parse(row(820).subscription_expires_at) > Date.now(), "the subscription itself was still activated");
});

// =====================================================================================
// Fail open
// =====================================================================================
test("DATABASE DOWN: /invite explains, deep links and audio still work, nothing throws", async () => {
  const keyboard = await pdfSummary(900); // built while the database is up
  net.dbDown = true;
  try {
    const before = countTo(900);
    say(900, "/invite");
    await waitFor(() => countTo(900) === before + 1, "invite unavailable message");
    assert.match(lastTo(900).text, /الان نمی‌تونم لینک دعوتت رو بسازم/);

    say(901, "/start ref_ABCD2345");
    await waitFor(() => countTo(901) >= 1, "welcome");
    await sleep(50);
    assert.match(bot.messagesTo(901)[0].text, /^سلام! به کوله خوش اومدی/);

    tap(900, 900, audioData(keyboard));
    await waitFor(() => bot.voices.some((v) => v.chatId === 900), "audio while the database is down");

    await translate(902); // core feature fails open; referral bookkeeping is skipped
  } finally {
    net.dbDown = false;
  }
});

test("the invite/audio/coupon wiring left the free tools alone: compression still works with no payment pending", async () => {
  const docsBefore = bot.documents.length;
  sendPhoto(950);
  await waitFor(() => bot.documents.length === docsBefore + 1, "compressed");
});

// =====================================================================================
// 🔊 تبدیل متن به صدا (free text to speech)
// =====================================================================================
async function tapTts(id) {
  const before = countTo(id);
  say(id, MENU.TTS);
  await waitFor(() => countTo(id) === before + 1, "text-to-speech prompt");
}
const voicesTo = (id) => bot.voices.filter((v) => v.chatId === id);

test("🔊 asks for the text, states the limit, then reads it aloud as a voice message (one billable request)", async () => {
  await tapTts(1301);
  assert.match(lastTo(1301).text, /حداکثر حدود ۴٬۰۰۰ کاراکتر/);
  assert.match(lastTo(1301).text, /یه درخواست از سهمیه‌ات حساب می‌شه/);

  const callsBefore = tts.calls.length;
  say(1301, "سلام، این یک متن آزمایشی برای تبدیل به صدا است.");
  await waitFor(() => voicesTo(1301).length === 1, "voice message");

  const voice = voicesTo(1301)[0];
  assert.equal(voice.fileOpts.filename, "speech.ogg");
  assert.equal(voice.fileOpts.contentType, "audio/ogg");
  assert.equal(voice.buffer.toString(), "OggS-fake-opus-audio");
  assert.equal(tts.calls.length, callsBefore + 1);
  assert.equal(tts.calls.at(-1), "سلام، این یک متن آزمایشی برای تبدیل به صدا است.");
  assert.equal(row(1301).weekly_request_count, 1, "counted like any billable action");
  await waitFor(() => bot.deleted.some((d) => d.chatId === 1301), "the processing message is cleaned up");
  assert.ok(bot.messagesTo(1301).some((m) => /در حال تبدیل متن به صدا/.test(m.text)));
});

test("the tap is one-shot: the next plain text goes back to the Word export", async () => {
  await tapTts(1302);
  say(1302, "این متن به صدا تبدیل می‌شه.");
  await waitFor(() => voicesTo(1302).length === 1, "audio");
  const docsBefore = bot.documents.filter((d) => d.chatId === 1302).length;
  say(1302, "و این یکی فقط یه متن معمولیه.");
  await waitFor(() => bot.documents.filter((d) => d.chatId === 1302).length === docsBefore + 1, "word export");
  assert.equal(voicesTo(1302).length, 1);
});

test("the limit: 4,000 characters are accepted, more are refused with a clear message and cost nothing", async () => {
  await tapTts(1310);
  const callsBefore = tts.calls.length;
  say(1310, "الف ".repeat(1001)); // 4,004 characters
  await waitFor(() => /خیلی طولانیه/.test(lastTo(1310).text), "too-long message");
  const msg = lastTo(1310).text;
  assert.match(msg, /۴٬۰۰۴ کاراکتر/, "says how long the text was");
  assert.match(msg, /حداکثر حدود ۴٬۰۰۰ کاراکتر/, "says the limit");
  assert.match(msg, /۶ دقیقه/);
  assert.equal(tts.calls.length, callsBefore, "nothing synthesized");
  assert.equal(row(1310), undefined, "nothing charged (no billable request was made)");

  // Still waiting for a text: a shorter one now works, right at the limit.
  say(1310, "ب".repeat(4000));
  await waitFor(() => voicesTo(1310).length === 1, "audio for a 4000-character text");
  assert.equal(row(1310).weekly_request_count, 1);
});

test("text with nothing to read (only emoji or symbols) is refused, and the user can try again", async () => {
  await tapTts(1320);
  say(1320, "🎒🎒 ---");
  await waitFor(() => /چیزی برای خوندن پیدا نکردم/.test(lastTo(1320).text), "nothing to read");
  assert.equal(voicesTo(1320).length, 0);
  say(1320, "حالا یه متن درست.");
  await waitFor(() => voicesTo(1320).length === 1, "audio");
});

test("if synthesis fails the user is told and the request is refunded", async () => {
  await tapTts(1330);
  tts.fail = true;
  say(1330, "این متن قرار است شکست بخورد.");
  await waitFor(() => bot.messagesTo(1330).some((m) => /ساخت نسخه صوتی با مشکل مواجه شد/.test(m.text)), "error");
  tts.fail = false;
  assert.equal(voicesTo(1330).length, 0);
  await waitFor(() => row(1330).weekly_request_count === 0, "refund");
});

test("3 free requests a week apply: the 4th billable action (here text to speech) hits the paywall", async () => {
  await translate(1340);
  await translate(1340);
  await tapTts(1340);
  say(1340, "سومین درخواست.");
  await waitFor(() => voicesTo(1340).length === 1, "third request, audio");
  assert.equal(row(1340).weekly_request_count, 3);

  await tapTts(1340);
  const callsBefore = tts.calls.length;
  const before = countTo(1340);
  say(1340, "چهارمین درخواست.");
  await waitFor(() => countTo(1340) === before + 1, "paywall");
  assert.match(lastTo(1340).text, /سهمیه‌ی رایگان/);
  assert.equal(voicesTo(1340).length, 1);
  assert.equal(tts.calls.length, callsBefore);
});

test("subscribers share ONE daily cap of 15 between summary audio and text to speech", async () => {
  const keyboard = await pdfSummary(1350);
  row(1350).subscription_expires_at = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

  for (let i = 1; i <= 10; i++) {
    tap(1350, 1350, audioData(keyboard));
    await waitFor(() => voicesTo(1350).length === i, `summary audio #${i}`);
  }
  for (let i = 11; i <= 15; i++) {
    await tapTts(1350);
    say(1350, `متن شماره ${i}.`);
    await waitFor(() => voicesTo(1350).length === i, `text audio #${i}`);
  }
  assert.equal(row(1350).weekly_request_count, 1, "a subscriber's audio never touches the weekly counter");

  await tapTts(1350);
  const before = countTo(1350);
  say(1350, "شانزدهمین.");
  await waitFor(() => countTo(1350) === before + 1, "cap message");
  assert.match(lastTo(1350).text, /سقف ۱۵ نسخه‌ی صوتی در روز/);
  assert.equal(voicesTo(1350).length, 15, "no 16th audio");
});

test("a second text while one is still being converted is refused (one conversion at a time)", async () => {
  let release;
  tts.gate = new Promise((resolve) => (release = resolve));
  await tapTts(1360);
  say(1360, "اولین متن که طول می‌کشد.");
  await waitFor(() => tts.calls.at(-1) === "اولین متن که طول می‌کشد.", "first conversion running");

  await tapTts(1360);
  const before = countTo(1360);
  say(1360, "دومین متن همزمان.");
  await waitFor(() => countTo(1360) === before + 1, "busy message");
  assert.match(lastTo(1360).text, /از قبل در حال ساخته شدنه/);
  assert.equal(row(1360).weekly_request_count, 1, "the refused text cost nothing");

  tts.gate = null;
  release();
  await waitFor(() => voicesTo(1360).length === 1, "first audio delivered");
});

test("an invited user's first request can be text to speech: it qualifies the referral", async () => {
  const code = await inviteCodeOf(1370);
  say(1371, `/start ref_${code}`);
  await waitFor(() => countTo(1371) === 2, "attribution");
  await tapTts(1371);
  say(1371, "اولین درخواست من یک متن به صدا است.");
  await waitFor(() => voicesTo(1371).length === 1, "audio");
  await waitFor(() => row(1371).bonus_requests === 2 && row(1370).bonus_requests === 2, "both bonuses");
  assert.equal(row(1370).successful_referrals, 1);
});

test("TTS switched off: the menu button says so, and no mode is left waiting", async () => {
  const original = config.TTS_ENABLED;
  try {
    config.TTS_ENABLED = false;
    const before = countTo(1380);
    say(1380, MENU.TTS);
    await waitFor(() => countTo(1380) === before + 1, "reply");
    assert.match(lastTo(1380).text, /فعلاً روی این بات فعال نیست/);
    const docsBefore = bot.documents.filter((d) => d.chatId === 1380).length;
    say(1380, "این باید ورد بشه.");
    await waitFor(() => bot.documents.filter((d) => d.chatId === 1380).length === docsBefore + 1, "word export");
  } finally {
    config.TTS_ENABLED = original;
  }
});

test("DATABASE DOWN: text to speech still works (fail open)", async () => {
  net.dbDown = true;
  try {
    await tapTts(1390);
    say(1390, "متن در زمان قطعی دیتابیس.");
    await waitFor(() => voicesTo(1390).length === 1, "audio while the database is down");
  } finally {
    net.dbDown = false;
  }
});

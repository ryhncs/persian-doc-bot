// Make sure a developer's real .env can't switch monetization on under test.
for (const key of ["SUPABASE_URL", "SUPABASE_KEY", "SUBSCRIPTION_PRICE_TOMAN", "CARD_NUMBER", "ADMIN_CHAT_ID"]) {
  process.env[key] = "";
}

const test = require("node:test");
const assert = require("node:assert/strict");

const { MENU, mainMenuKeyboard, isMenuLabel, handleMenuButton } = require("../src/handlers/menu");
const { modes, MODES } = require("../src/services/userMode");

function mockBot() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, opts) {
      sent.push({ chatId, text, opts });
      return { message_id: sent.length };
    },
  };
}

const tap = (label, userId = 7) => ({ chat: { id: userId }, from: { id: userId }, text: label });

test("menu labels are exactly the requested wording (ZWNJ included)", () => {
  assert.equal(MENU.VOICE, "🎙 خلاصه پیام صوتی");
  assert.equal(MENU.PDF, "📄 خلاصه جزوه PDF");
  assert.equal(MENU.TRANSLATE, "🌐 ترجمه و ساده‌سازی متن");
  assert.equal(MENU.COMPRESS, "🗜 فشرده‌سازی عکس و PDF");
  assert.equal(MENU.SUBSCRIBE, "💳 خرید اشتراک");
});

test("the keyboard is a persistent reply keyboard with the seven buttons, not inline buttons", () => {
  const kb = mainMenuKeyboard();
  assert.equal(kb.is_persistent, true);
  assert.equal(kb.resize_keyboard, true);
  assert.equal(kb.inline_keyboard, undefined);
  assert.deepEqual(kb.keyboard.flat(), [MENU.VOICE, MENU.PDF, MENU.TRANSLATE, MENU.COMPRESS, MENU.SUBSCRIBE, MENU.INVITE, MENU.TTS]);
  assert.equal(MENU.TTS, "🔊 تبدیل متن به صدا");
  assert.equal(MENU.INVITE, "🎁 دعوت دوستان");
});

test("isMenuLabel recognizes the labels (ignoring stray whitespace) and nothing else", () => {
  for (const label of Object.values(MENU)) assert.equal(isMenuLabel(label), true);
  assert.equal(isMenuLabel(`  ${MENU.PDF}\n`), true);
  assert.equal(isMenuLabel("خلاصه"), false);
  assert.equal(isMenuLabel("hello"), false);
});

test("🎙 asks for a voice message and leaves no mode behind", async () => {
  modes.set(7, MODES.TRANSLATE);
  const bot = mockBot();
  await handleMenuButton(bot, tap(MENU.VOICE));
  assert.match(bot.sent[0].text, /پیام صوتیت رو بفرست/);
  assert.equal(modes.peek(7), null);
});

test("📄 asks for a PDF and makes the next PDF a summary request", async () => {
  const bot = mockBot();
  await handleMenuButton(bot, tap(MENU.PDF));
  assert.match(bot.sent[0].text, /PDF/);
  assert.equal(modes.peek(7), MODES.SUMMARIZE_PDF);
  modes.clear(7);
});

test("🌐 asks for a text and makes the next text a translate request", async () => {
  const bot = mockBot();
  await handleMenuButton(bot, tap(MENU.TRANSLATE));
  assert.match(bot.sent[0].text, /متنی که می‌خوای ترجمه بشه/);
  assert.match(bot.sent[0].text, /فارسیه، به انگلیسی/, "says both directions");
  assert.match(bot.sent[0].text, /زبان رو خودم تشخیص می‌دم/);
  assert.equal(modes.peek(7), MODES.TRANSLATE);
  modes.clear(7);
});

test("🗜 asks for a photo or PDF and makes the next one a compression request", async () => {
  const bot = mockBot();
  await handleMenuButton(bot, tap(MENU.COMPRESS));
  assert.match(bot.sent[0].text, /عکس یا فایل PDF/);
  assert.equal(modes.peek(7), MODES.COMPRESS);
  modes.clear(7);
});

test("💳 shows the subscription screen and clears any earlier mode", async () => {
  modes.set(7, MODES.COMPRESS);
  const bot = mockBot();
  await handleMenuButton(bot, tap(MENU.SUBSCRIBE));
  assert.equal(bot.sent.length, 1);
  assert.equal(modes.peek(7), null);
});

test("modes are per user", async () => {
  const bot = mockBot();
  await handleMenuButton(bot, tap(MENU.TRANSLATE, 1));
  assert.equal(modes.peek(1), MODES.TRANSLATE);
  assert.equal(modes.peek(2), null);
  modes.clear(1);
});

test("🔊 asks for the text to read aloud, states the limit, and makes the next text a speech request", async () => {
  const bot = mockBot();
  await handleMenuButton(bot, tap(MENU.TTS));
  assert.match(bot.sent[0].text, /متنی که می‌خوای به صدا تبدیل بشه/);
  assert.match(bot.sent[0].text, /۴٬۰۰۰ کاراکتر/);
  assert.match(bot.sent[0].text, /۶ دقیقه/);
  assert.equal(modes.peek(7), MODES.TTS_TEXT);
  modes.clear(7);
});

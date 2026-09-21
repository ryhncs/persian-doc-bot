const test = require("node:test");
const assert = require("node:assert/strict");

const { WELCOME_TEXT, welcomeMessage, helpMessage } = require("../src/messages");

// The requested /start text, character for character. ZWNJs (‌) are
// spelled out so the test doesn't depend on how the text was typed.
const EXPECTED_WELCOME = [
  "سلام! به کوله خوش اومدی 🎒",
  "من اینجام تا تو درس خوندنت کمکت کنم: می‌تونم پیام صوتیت رو خلاصه کنم، جزوه‌ی PDF رو براوت خلاصه کنم، یه متن رو ترجمه و ساده کنم، یا حجم عکس و PDF رو کوچیک کنم.",
  "هر هفته ۳ تا درخواست رایگان داری. برای استفاده‌ی بیشتر هم اشتراک ماهانه داریم، فقط ۱۲۰ هزار تومن.",
  "از منوی پایین یکی از گزینه‌ها رو انتخاب کن و شروع کن.",
].join("\n");

test("/start text is exactly the requested wording", () => {
  assert.equal(welcomeMessage(), EXPECTED_WELCOME);
  assert.equal(WELCOME_TEXT, EXPECTED_WELCOME);
});

test("/start text has no em or en dashes", () => {
  assert.doesNotMatch(welcomeMessage(), /[–—]/);
});

test("/start text is four lines and mentions the 3 free requests and the price", () => {
  const lines = welcomeMessage().split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[2], /۳ تا درخواست رایگان/);
  assert.match(lines[2], /۱۲۰ هزار تومن/);
});

test("/help mentions the menu and no longer uses em dashes", () => {
  const help = helpMessage();
  assert.match(help, /منوی پایین/);
  assert.doesNotMatch(help, /[–—]/);
});

// --- /help ------------------------------------------------------------------
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "test-key";
const config = require("../src/config");

test("/help lists every feature of the bot", () => {
  const help = helpMessage();
  const topics = {
    "voice summary": /🎙 خلاصه پیام صوتی/,
    "PDF summary": /📄 خلاصه جزوه PDF/,
    "translate, both directions": /فارسی باشه به انگلیسی ترجمه می‌شه، انگلیسی/,
    "language is detected": /زبان رو خودم تشخیص می‌دم/,
    "compression": /🗜 فشرده‌سازی عکس و PDF/,
    "text to speech": /🔊 تبدیل متن به صدا/,
    "audio version of summaries": /دریافت نسخه صوتی/,
    "referrals": /🎁 دعوت دوستان/,
    "coupon": /کوپن/,
    "how to buy": /💳 خرید اشتراک.*کارت‌به‌کارت.*رسید/,
    "Word export": /Word/,
  };
  for (const [name, pattern] of Object.entries(topics)) assert.match(help, pattern, `/help should mention: ${name}`);
});

test("/help has no em dashes, en dashes or other long dashes, in any configuration", () => {
  const original = { ...config };
  try {
    for (const monetization of [false, true]) {
      config.MONETIZATION_ENABLED = monetization;
      config.ADMIN_CONTACT = monetization ? "@kooleh_admin" : "";
      config.SUBSCRIPTION_PRICE_TOMAN = "120000";
      assert.doesNotMatch(helpMessage(), /[\u2010-\u2015\u2212]/);
    }
  } finally {
    Object.assign(config, original);
  }
});

test("/help is concise: fits comfortably in one Telegram message", () => {
  config.MONETIZATION_ENABLED = true;
  try {
    assert.ok(helpMessage().length < 2500, `help is ${helpMessage().length} chars`);
  } finally {
    config.MONETIZATION_ENABLED = false;
  }
});

test("/help states the text-to-speech limit from config and the subscription price when limits are on", () => {
  const original = { ...config };
  try {
    config.MONETIZATION_ENABLED = true;
    config.SUBSCRIPTION_PRICE_TOMAN = "120000";
    const help = helpMessage();
    assert.match(help, /۴٬۰۰۰ کاراکتر/);
    assert.match(help, /۱۲۰٬۰۰۰ تومان/);
    assert.match(help, /هر هفته ۳ درخواست رایگان/);
  } finally {
    Object.assign(config, original);
  }
});

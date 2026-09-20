const test = require("node:test");
const assert = require("node:assert/strict");

const { WELCOME_TEXT, welcomeMessage, helpMessage } = require("../src/messages");

// The requested /start text, character for character. ZWNJs (‌) are
// spelled out so the test doesn't depend on how the text was typed.
const EXPECTED_WELCOME = [
  "سلام! به کوله خوش اومدی 🎒",
  "من اینجام تا تو درس خوندنت کمکت کنم: می‌تونم پیام صوتیت رو خلاصه کنم، جزوه‌ی PDF رو براوت خلاصه کنم، یه متن رو ترجمه و ساده کنم، یا حجم عکس و PDF رو کوچیک کنم.",
  "هر هفته ۳ تا درخواست رایگان داری. برای استفاده‌ی بیشتر هم اشتراک ماهانه داریم، فقط ۱۲۰ هزار تومن، یعنی روزی کمتر از یه بلیط مترو.",
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

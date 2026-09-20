const config = require("./config");
const { formatNumber } = require("./utils/format");

// Shown on /start, together with the persistent menu. Wording is fixed by the
// product owner; the free-request count and price are part of the copy, so if
// FREE_REQUESTS_PER_WEEK or SUBSCRIPTION_PRICE_TOMAN change, update it here.
const WELCOME_TEXT = [
  "سلام! به کوله خوش اومدی 🎒",
  "من اینجام تا تو درس خوندنت کمکت کنم: می‌تونم پیام صوتیت رو خلاصه کنم، جزوه‌ی PDF رو براوت خلاصه کنم، یه متن رو ترجمه و ساده کنم، یا حجم عکس و PDF رو کوچیک کنم.",
  "هر هفته ۳ تا درخواست رایگان داری. برای استفاده‌ی بیشتر هم اشتراک ماهانه داریم، فقط ۱۲۰ هزار تومن، یعنی روزی کمتر از یه بلیط مترو.",
  "از منوی پایین یکی از گزینه‌ها رو انتخاب کن و شروع کن.",
].join("\n");

function welcomeMessage() {
  return WELCOME_TEXT;
}

function limitsParagraph() {
  if (!config.MONETIZATION_ENABLED) return null;
  return `🎁 هر هفته ${formatNumber(config.FREE_REQUESTS_PER_WEEK)} درخواست رایگان برای خلاصه‌سازی صوت و PDF و ترجمه داری. ساخت Word و کم کردن حجم فایل همیشه رایگانه. برای استفاده‌ی نامحدود هم می‌تونی اشتراک ماهانه بگیری.`;
}

function helpMessage() {
  const lines = [
    "راهنمای «کوله» 🎒",
    "",
    "همه‌چیز از منوی پایین شروع می‌شه:",
    "🎙 خلاصه پیام صوتی: پیام صوتیت رو بفرست (یا فوروارد کن) تا متنش رو پیاده و خلاصه کنم.",
    "📄 خلاصه جزوه PDF: PDF متن‌دار رو بفرست تا خلاصه‌ش کنم.",
    "🌐 ترجمه و ساده‌سازی متن: متنت رو بفرست تا ترجمه و ساده‌ش کنم.",
    "🗜 فشرده‌سازی عکس و PDF: عکس یا PDF بفرست تا حجمش کم بشه.",
    "📝 هر متنی هم که بفرستی، یه فایل Word مرتب و راست‌به‌چپ برات می‌سازم.",
    "",
    "نکته‌ها:",
    `• پیام صوتی باید بین ${formatNumber(config.MIN_VOICE_DURATION_SECONDS)} ثانیه تا ${formatNumber(Math.round(config.MAX_VOICE_DURATION_SECONDS / 60))} دقیقه باشه.`,
    "• پی‌دی‌اف برای خلاصه‌سازی باید متن‌دار باشه (نه اسکن).",
    "• فایل‌ها حداکثر ۲۰ مگابایت.",
  ];

  const limits = limitsParagraph();
  if (limits) {
    lines.push(
      "",
      limits,
      `💳 اشتراک ماهانه: ${formatNumber(config.SUBSCRIPTION_PRICE_TOMAN)} تومان. از دکمه‌ی «💳 خرید اشتراک» راه پرداخت رو ببین.`
    );
    if (config.ADMIN_CONTACT) lines.push(`📩 پشتیبانی: ${config.ADMIN_CONTACT}`);
  }

  return lines.join("\n");
}

module.exports = { WELCOME_TEXT, welcomeMessage, helpMessage };

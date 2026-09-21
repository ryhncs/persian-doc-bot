const config = require("./config");
const { formatNumber } = require("./utils/format");

// Shown on /start, together with the persistent menu. Wording is fixed by the
// product owner; the free-request count and price are part of the copy, so if
// FREE_REQUESTS_PER_WEEK or SUBSCRIPTION_PRICE_TOMAN change, update it here.
const WELCOME_TEXT = [
  "سلام! به کوله خوش اومدی 🎒",
  "من اینجام تا تو درس خوندنت کمکت کنم: می‌تونم پیام صوتیت رو خلاصه کنم، جزوه‌ی PDF رو براوت خلاصه کنم، یه متن رو ترجمه و ساده کنم، یا حجم عکس و PDF رو کوچیک کنم.",
  "هر هفته ۳ تا درخواست رایگان داری. برای استفاده‌ی بیشتر هم اشتراک ماهانه داریم، فقط ۱۲۰ هزار تومن.",
  "از منوی پایین یکی از گزینه‌ها رو انتخاب کن و شروع کن.",
].join("\n");

function welcomeMessage() {
  return WELCOME_TEXT;
}

function limitsParagraph() {
  if (!config.MONETIZATION_ENABLED) return null;
  return `🎁 هر هفته ${formatNumber(config.FREE_REQUESTS_PER_WEEK)} درخواست رایگان داری. خلاصه‌ی صوت و PDF، ترجمه، تبدیل متن به صدا و نسخه‌ی صوتی هر کدوم یه درخواست حساب می‌شن. ساخت Word و کم کردن حجم فایل همیشه رایگانه.`;
}

// /help: everything the bot can do, in Persian, one short line each. Keep the
// text free of em and en dashes (a product requirement).
function helpMessage() {
  const lines = [
    "راهنمای «کوله» 🎒",
    "",
    "همه‌چیز از منوی پایین شروع می‌شه:",
    "",
    "🎙 خلاصه پیام صوتی: پیام صوتیت رو بفرست (یا فوروارد کن) تا پیاده و خلاصه‌ش کنم.",
    "📄 خلاصه جزوه PDF: یه PDF متن‌دار (نه اسکن) بفرست تا خلاصه‌ش کنم. جزوه‌ی بلند هم مشکلی نیست، فقط یه کم بیشتر طول می‌کشه.",
    "🌐 ترجمه و ساده‌سازی متن: متنت رو بفرست. فارسی باشه به انگلیسی ترجمه می‌شه، انگلیسی (یا هر زبون دیگه) باشه به فارسی روان و ساده برمی‌گرده. زبان رو خودم تشخیص می‌دم.",
    "🗜 فشرده‌سازی عکس و PDF: عکس یا PDF بفرست تا حجمش کم بشه.",
    `🔊 تبدیل متن به صدا: متنت رو بفرست تا به پیام صوتی تبدیل بشه (حداکثر حدود ${formatNumber(config.TTS_TEXT_MAX_CHARS)} کاراکتر). زیر خلاصه‌ی صوت و PDF هم دکمه‌ی «دریافت نسخه صوتی» هست.`,
    "🎁 دعوت دوستان: لینک اختصاصیت رو بگیر. هر دوستی که با لینک تو بیاد و اولین درخواستش رو انجام بده، هر دوتون درخواست رایگان اضافه می‌گیرید و با هر ۳ دعوت موفق یه کوپن ۲۰٪ تخفیف اشتراک برات جمع می‌شه (دستور /invite هم همین کار رو می‌کنه).",
    "💳 خرید اشتراک: قیمت و شماره کارت رو ببین، کارت‌به‌کارت کن و اسکرین‌شات رسید رو همون‌جا برام بفرست. بعد از تایید، اشتراکت فعال می‌شه.",
    "",
    "نکته‌ها:",
    "📝 هر متنی که بدون انتخاب دکمه بفرستی، یه فایل Word مرتب و راست‌به‌چپ برات می‌سازم.",
    `• پیام صوتی باید بین ${formatNumber(config.MIN_VOICE_DURATION_SECONDS)} ثانیه تا ${formatNumber(Math.round(config.MAX_VOICE_DURATION_SECONDS / 60))} دقیقه باشه.`,
    "• فایل‌ها حداکثر ۲۰ مگابایت.",
  ];

  const limits = limitsParagraph();
  if (limits) {
    lines.push(
      "",
      limits,
      `💳 اشتراک ماهانه: ${formatNumber(config.SUBSCRIPTION_PRICE_TOMAN)} تومان و بدون محدودیت.`
    );
    if (config.ADMIN_CONTACT) lines.push(`📩 پشتیبانی: ${config.ADMIN_CONTACT}`);
  }

  return lines.join("\n");
}

module.exports = { WELCOME_TEXT, welcomeMessage, helpMessage };

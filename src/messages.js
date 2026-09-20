const config = require("./config");
const { formatNumber } = require("./utils/format");

const FEATURES = [
  "🎙 پیام صوتی بفرست (یا فوروارد کن) تا متنش رو پیاده و خلاصه کنم.",
  "📄 پی‌دی‌اف بفرست تا خلاصه‌ش کنم یا حجمش رو کم کنم.",
  "📝 هر متنی بفرستی (کپی‌شده از واتساپ، وردپرس، هر جا)، یه فایل Word مرتب و راست‌به‌چپ برات می‌سازم؛ زیرش هم دکمه‌ی «ترجمه و ساده‌سازی (فارسی)» و «ترجمه به انگلیسی» هست.",
  "🖼 عکس بفرست تا حجمش رو کم کنم.",
];

function limitsParagraph() {
  if (!config.MONETIZATION_ENABLED) return null;
  return `🎁 هر هفته ${formatNumber(config.FREE_REQUESTS_PER_WEEK)} درخواست رایگان برای خلاصه‌سازی صوت و PDF و ترجمه داری. ساخت Word و کم کردن حجم فایل همیشه رایگانه. برای استفاده‌ی نامحدود هم می‌تونی اشتراک ماهانه بگیری.`;
}

function welcomeMessage() {
  return [
    "سلام! من «کوله» هستم 🎒 دستیار درسی‌ت.",
    "",
    "اینا رو برات انجام می‌دم:",
    ...FEATURES,
    ...(limitsParagraph() ? ["", limitsParagraph()] : []),
    "",
    "کافیه چیزی که می‌خوای رو بفرستی — چیز دیگه‌ای لازم نیست. راهنمای بیشتر: /help",
  ].join("\n");
}

function helpMessage() {
  const lines = [
    "راهنمای «کوله» 🎒",
    "",
    ...FEATURES,
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
      `💳 اشتراک ماهانه: ${formatNumber(config.SUBSCRIPTION_PRICE_TOMAN)} تومان — وقتی سهمیه‌ت تموم شد، ربات خودش راه پرداخت رو بهت نشون می‌ده.`
    );
    if (config.ADMIN_CONTACT) lines.push(`📩 پشتیبانی: ${config.ADMIN_CONTACT}`);
  }

  return lines.join("\n");
}

module.exports = { welcomeMessage, helpMessage };

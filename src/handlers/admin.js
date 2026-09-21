const config = require("../config");
const { usage } = require("../services/usage");
const { formatNumber, formatPersianDate } = require("../utils/format");

const ALERT_INTERVAL_MS = 60 * 60 * 1000;

function isAdminChat(chatId) {
  return Boolean(config.ADMIN_CHAT_ID) && String(chatId) === String(config.ADMIN_CHAT_ID);
}

/** Builds the /status text from usage.diagnose()'s report. Exported for tests. */
function buildStatusText(report, cfg = config, now = Date.now()) {
  const lines = ["🔧 وضعیت کوله", ""];

  if (report.enabled) {
    lines.push("• اعمال محدودیت‌ها: فعال ✅");
  } else {
    lines.push(
      "• اعمال محدودیت‌ها: غیرفعال ❌ (همه‌چیز نامحدوده)",
      `  متغیرهای تنظیم‌نشده: ${cfg.MISSING_MONETIZATION_VARS.join(", ") || "-"}`
    );
    return lines.join("\n");
  }

  if (report.db.ok) {
    lines.push("• اتصال Supabase: سالم ✅");
  } else {
    lines.push(
      "• اتصال Supabase: مشکل ❌ (تا وقتی درست نشه محدودیت‌ها اعمال نمی‌شن و همه‌چیز نامحدوده)",
      `  ${report.db.error}`
    );
    return lines.join("\n");
  }

  lines.push(`• سهمیه‌ی رایگان: ${formatNumber(report.limit)} درخواست در هفته`);

  const u = report.user;
  if (!u) {
    lines.push("• حساب شما: هنوز رکوردی نداره (بعد از اولین درخواست ساخته می‌شه)");
  } else if (u.subscribedUntil) {
    lines.push(`• حساب شما: اشتراک فعال تا ${formatPersianDate(u.subscribedUntil)} (نامحدود)`);
  } else if (u.windowExpired) {
    lines.push(`• حساب شما: بازه‌ی قبلی تموم شده، درخواست بعدی از نو شمرده می‌شه`);
  } else {
    lines.push(
      `• حساب شما: ${formatNumber(u.used)} از ${formatNumber(report.limit)} درخواست استفاده شده، ریست ${formatPersianDate(u.resetAt)}`
    );
  }

  return lines.join("\n");
}

/** /status: admin-only; silently ignored for everyone else. */
async function handleStatusCommand(bot, msg) {
  if (!isAdminChat(msg.chat.id)) return;
  const report = await usage.diagnose(msg.from.id);
  await bot.sendMessage(msg.chat.id, buildStatusText(report));
}

/**
 * Wires the usage service's "database failed, letting the request through"
 * event to a DM to the admin (at most once an hour), so a broken database
 * can't silently turn the whole bot into an unlimited free one.
 */
function installDegradedAlert(
  bot,
  { usageService = usage, adminChatId = config.ADMIN_CHAT_ID, now = () => Date.now() } = {}
) {
  if (!adminChatId) return;
  let lastAlertAt = 0;
  usageService.setDegradedHandler((err) => {
    if (now() - lastAlertAt < ALERT_INTERVAL_MS) return;
    lastAlertAt = now();
    bot
      .sendMessage(
        adminChatId,
        `⚠️ دیتابیس (Supabase) خطا داد، برای همین محدودیت رایگان الان اعمال نمی‌شه و همه‌چیز موقتاً نامحدوده.\nخطا: ${err && err.message}\nبرای دیدن وضعیت کامل: /status`
      )
      .catch(() => {});
  });
}

module.exports = { isAdminChat, buildStatusText, handleStatusCommand, installDegradedAlert };

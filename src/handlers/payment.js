const config = require("../config");
const { usage } = require("../services/usage");
const { escapeHtml, formatNumber, formatPersianDate, daysUntil } = require("../utils/format");

const RECEIPT_RECEIVED =
  "✅ رسیدت برای بررسی ارسال شد. به‌محض تایید بهت خبر می‌دم.";
const RECEIPT_ALREADY_SENT = "رسیدت رو قبلاً گرفتم و در حال بررسیه، یه کم صبر کن 🙏";
const RECEIPT_ERROR = "ارسال رسید با مشکل مواجه شد. چند دقیقه دیگه دوباره امتحان کن.";
const ADMIN_ONLY = "این دکمه فقط برای ادمینه.";
const ADMIN_SAVE_FAILED = "❌ ذخیره‌ی وضعیت در دیتابیس ناموفق بود. دوباره امتحان کن.";

const FORWARD_COOLDOWN_MS = 15 * 1000;

function parseUserId(raw) {
  return /^\d{1,15}$/.test(String(raw)) ? Number(raw) : null;
}

/**
 * Paywall + manual card-to-card payment flow. Built as a factory so the flow
 * can be exercised in tests with a fake usage service/config; the default
 * instance exported below is what the bot uses.
 */
function createPaymentHandlers({ usage, config, now = () => Date.now(), log = console }) {
  const lastForwardAt = new Map(); // userId -> ms, to stop receipt spam to the admin

  function paywallText(gate) {
    const lines = [
      `🔒 سهمیه‌ی رایگان این هفته‌ات (${formatNumber(gate.limit)} درخواست) تموم شد.`,
      "",
      "برای استفاده‌ی نامحدود از خلاصه‌سازی صوت و PDF و ترجمه، اشتراک ماهانه‌ی کوله رو بگیر:",
      "",
      `💰 قیمت: ${escapeHtml(formatNumber(config.SUBSCRIPTION_PRICE_TOMAN))} تومان (${formatNumber(config.SUBSCRIPTION_DAYS)} روز)`,
      `💳 شماره کارت: <code>${escapeHtml(config.CARD_NUMBER)}</code>`,
      "",
      "بعد از کارت‌به‌کارت، یه اسکرین‌شات از رسید پرداخت رو همین‌جا به‌صورت عکس برام بفرست. بعد از بررسی و تایید، اشتراکت فعال می‌شه ✅",
    ];

    if (gate.resetAt) {
      lines.push(
        "",
        `(اگه نمی‌خوای اشتراک بگیری، سهمیه‌ت ${formatNumber(daysUntil(gate.resetAt, now()))} روز دیگه دوباره شارژ می‌شه. ساخت Word و کم کردن حجم فایل هم همیشه رایگانه 😉)`
      );
    }

    return lines.join("\n");
  }

  async function sendPaywall(bot, chatId, userId, gate) {
    // From here on a photo from this user is treated as a payment receipt.
    await usage.markPaymentPending(userId);
    await bot.sendMessage(chatId, paywallText(gate), { parse_mode: "HTML" });
  }

  /**
   * Call before doing a premium feature. Returns the gate result if the user
   * may proceed, or null after replying with the paywall. Pass the result to
   * releasePremiumFeature() if the feature then fails to deliver.
   */
  async function gatePremiumFeature(bot, chatId, userId) {
    const gate = await usage.checkAndConsume(userId);
    if (gate.allowed) return gate;
    await sendPaywall(bot, chatId, userId, gate);
    return null;
  }

  function releasePremiumFeature(userId, gate) {
    return usage.refund(userId, gate);
  }

  /**
   * Called for every incoming photo before the image-compression handler.
   * Returns true if the photo was a payment receipt (and was handled here).
   */
  async function handlePaymentPhoto(bot, msg) {
    if (!usage.enabled) return false;

    const userId = msg.from.id;
    const { pending } = await usage.getPaymentState(userId);
    if (!pending) return false;

    const chatId = msg.chat.id;
    const t = now();
    const last = lastForwardAt.get(userId);
    if (last && t - last < FORWARD_COOLDOWN_MS) {
      await bot.sendMessage(chatId, RECEIPT_ALREADY_SENT);
      return true;
    }

    const largest = msg.photo[msg.photo.length - 1];
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || "—";
    const handle = msg.from.username ? `@${msg.from.username}` : "(بدون یوزرنیم)";
    const caption = [
      "💳 رسید پرداخت جدید",
      `👤 ${name} ${handle}`,
      `🆔 ${userId}`,
      `💰 مبلغ اشتراک: ${formatNumber(config.SUBSCRIPTION_PRICE_TOMAN)} تومان`,
    ].join("\n");

    try {
      await bot.sendPhoto(config.ADMIN_CHAT_ID, largest.file_id, {
        caption,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ تایید", callback_data: `pay:approve:${userId}` },
              { text: "❌ رد", callback_data: `pay:reject:${userId}` },
            ],
          ],
        },
      });
    } catch (err) {
      // Most likely the admin never pressed Start on this bot.
      log.error(`[payment] could not forward receipt from ${userId} to admin chat:`, err && err.message);
      await bot.sendMessage(chatId, RECEIPT_ERROR);
      return true;
    }

    lastForwardAt.set(userId, t);
    await bot.sendMessage(chatId, RECEIPT_RECEIVED);
    return true;
  }

  async function notifyUser(bot, adminChatId, targetUserId, text) {
    try {
      await bot.sendMessage(targetUserId, text);
    } catch (err) {
      log.error(`[payment] could not message user ${targetUserId}:`, err && err.message);
      await bot
        .sendMessage(adminChatId, `⚠️ نتیجه ثبت شد ولی نتونستم به کاربر ${targetUserId} پیام بدم (شاید ربات رو بلاک کرده).`)
        .catch(() => {});
    }
  }

  async function markAdminMessage(bot, message, suffix) {
    try {
      await bot.editMessageCaption(`${message.caption || ""}\n\n${suffix}`.trim(), {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      log.error("[payment] could not update admin message:", err && err.message);
    }
  }

  /** Handles the admin's "✅ تایید" / "❌ رد" buttons (callback_data "pay:<action>:<userId>"). */
  async function handlePaymentCallback(bot, callbackQuery, action, targetRaw) {
    const adminChatId = String(config.ADMIN_CHAT_ID);
    const message = callbackQuery.message;
    const fromChatId = message && message.chat && message.chat.id;

    // These buttons only exist in the admin chat; still refuse anyone else.
    if (!usage.enabled || String(fromChatId) !== adminChatId) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: ADMIN_ONLY, show_alert: true });
      return;
    }

    const targetUserId = parseUserId(targetRaw);
    if (!targetUserId || (action !== "approve" && action !== "reject")) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: "درخواست نامعتبر.", show_alert: true });
      return;
    }

    if (action === "approve") {
      let expiresAt;
      try {
        expiresAt = await usage.activateSubscription(targetUserId, config.SUBSCRIPTION_DAYS);
      } catch (err) {
        log.error(`[payment] approve failed for ${targetUserId}:`, err && err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: ADMIN_SAVE_FAILED, show_alert: true });
        return;
      }

      const date = formatPersianDate(expiresAt);
      await bot.answerCallbackQuery(callbackQuery.id, { text: "✅ تایید شد" });
      await notifyUser(
        bot,
        adminChatId,
        targetUserId,
        `🎉 پرداختت تایید شد و اشتراک کوله فعال شد!\n📅 اشتراکت تا ${date} (${formatNumber(config.SUBSCRIPTION_DAYS)} روز) اعتبار داره؛ تا اون موقع بدون محدودیت از همه‌ی امکانات استفاده کن.`
      );
      await markAdminMessage(bot, message, `✅ تایید شد (اشتراک تا ${date})`);
      return;
    }

    try {
      await usage.rejectPayment(targetUserId);
    } catch (err) {
      log.error(`[payment] reject failed for ${targetUserId}:`, err && err.message);
      await bot.answerCallbackQuery(callbackQuery.id, { text: ADMIN_SAVE_FAILED, show_alert: true });
      return;
    }

    const contact = config.ADMIN_CONTACT
      ? `اگه فکر می‌کنی اشتباهی شده با ادمین در تماس باش: ${config.ADMIN_CONTACT}`
      : "اگه فکر می‌کنی اشتباهی شده با ادمین تماس بگیر.";
    await bot.answerCallbackQuery(callbackQuery.id, { text: "❌ رد شد" });
    await notifyUser(
      bot,
      adminChatId,
      targetUserId,
      `😕 پرداختت تایید نشد. لطفاً یه بار دیگه مبلغ و شماره‌ی کارت رو چک کن و اگه درست بود، رسید رو دوباره به‌صورت عکس برام بفرست.\n${contact}`
    );
    await markAdminMessage(bot, message, "❌ رد شد");
  }

  return {
    gatePremiumFeature,
    releasePremiumFeature,
    handlePaymentPhoto,
    handlePaymentCallback,
  };
}

const defaults = createPaymentHandlers({ usage, config });

module.exports = { createPaymentHandlers, ...defaults };

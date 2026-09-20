const config = require("../config");
const { usage } = require("../services/usage");
const { escapeHtml, formatNumber } = require("../utils/format");

const INVITE_UNAVAILABLE = "الان نمی‌تونم لینک دعوتت رو بسازم، چند دقیقه دیگه دوباره امتحان کن 🙏";
const REFERRALS_OFF = "الان همه‌ی امکانات رایگانه و نیازی به دعوت دوستان نیست 😊";
const SHARE_TEXT = "با این لینک وارد «کوله» شو، دستیار درسی تلگرامی: خلاصه‌ی صوت و جزوه، ترجمه و ساده‌سازی متن.";

/**
 * Referral flow: the invite link and status screen (🎁 دعوت دوستان and
 * /invite), recording who invited a new user (/start ref_<code>), and telling
 * both sides once the invitee's first real request has been delivered. Built as
 * a factory so it can be tested with a fake usage service; the default instance
 * exported below is what the bot uses. Nothing here throws into the caller:
 * referrals fail open like the rest of monetization.
 */
function createReferralHandlers({ usage, config, log = console }) {
  let botUsername = config.BOT_USERNAME;

  const inviteLink = (code) => `https://t.me/${botUsername}?start=ref_${code}`;
  const pct = () => formatNumber(config.COUPON_DISCOUNT_PERCENT);

  function inviteText(info) {
    const lines = [
      "🎁 دعوت دوستان",
      "",
      "لینک اختصاصی تو:",
      inviteLink(info.code),
      "",
      `هر دوستی که با لینک تو وارد کوله بشه و اولین درخواستش رو انجام بده، هم تو هم اون ${formatNumber(config.REFERRAL_BONUS_REQUESTS)} درخواست رایگان اضافه می‌گیرید.`,
      `هر ${formatNumber(config.REFERRALS_PER_COUPON)} دعوت موفق هم یه کوپن ${pct()}٪ تخفیف اشتراک برات داره 🎟 (کوپن‌ها جمع می‌شن و تاریخ انقضا ندارن).`,
      "",
      "📊 وضعیت تو:",
      `• دعوت موفق: ${formatNumber(info.successful)}`,
      `• تا کوپن بعدی: ${formatNumber(info.untilNextCoupon)} دعوت موفق دیگه`,
      `• کوپن‌های آماده: ${formatNumber(info.coupons)}`,
      `• درخواست رایگان اضافه: ${formatNumber(info.bonusRequests)}`,
    ];
    if (info.bonusCapReached) {
      lines.push(
        "",
        `(سقف پاداش درخواست رایگان، یعنی ${formatNumber(config.REFERRAL_BONUS_CAP)} دعوت موفق، پر شده؛ دعوت‌های بعدی هنوز برای کوپن حساب می‌شن.)`
      );
    }
    return lines.join("\n");
  }

  /** The 🎁 دعوت دوستان button and /invite. */
  async function sendInviteInfo(bot, chatId, userId) {
    if (!usage.enabled) {
      await bot.sendMessage(chatId, REFERRALS_OFF);
      return;
    }
    const info = await usage.referrals.getInfo(userId);
    if (!info) {
      await bot.sendMessage(chatId, INVITE_UNAVAILABLE);
      return;
    }
    const share = `https://t.me/share/url?url=${encodeURIComponent(inviteLink(info.code))}&text=${encodeURIComponent(SHARE_TEXT)}`;
    await bot.sendMessage(chatId, inviteText(info), {
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "📤 ارسال برای دوستان", url: share }]] },
    });
  }

  /**
   * "/start ref_<code>": records the inviter for a new user and tells them what
   * happens next. The welcome message itself is sent separately and unchanged.
   */
  async function handleStartPayload(bot, msg, payload) {
    const match = /^ref_([A-Za-z0-9]{4,16})$/.exec(String(payload || ""));
    if (!match || !usage.enabled) return;

    const chatId = msg.chat.id;
    const result = await usage.referrals.attribute(msg.from.id, match[1]);
    if (result.ok) {
      await bot.sendMessage(
        chatId,
        `🎁 با دعوت یکی از دوستانت اومدی! بعد از اولین درخواستت، هم تو هم اون ${formatNumber(config.REFERRAL_BONUS_REQUESTS)} درخواست رایگان اضافه می‌گیرید.`
      );
    } else if (result.reason === "self") {
      await bot.sendMessage(chatId, "این لینک دعوت خودته 😄 برای دوستات بفرستش.");
    } else if (result.reason === "not_new" || result.reason === "already_referred") {
      await bot.sendMessage(chatId, "لینک دعوت فقط برای کاربرهای جدید کاره، ولی می‌تونی لینک خودت رو از «🎁 دعوت دوستان» بگیری.");
    }
  }

  async function safeSend(bot, chatId, text) {
    try {
      await bot.sendMessage(chatId, text);
    } catch (err) {
      log.error(`[referral] could not message ${chatId}:`, err && err.message);
    }
  }

  /**
   * Call after a billable request (voice/PDF summary, translation, audio
   * version) was actually delivered. The first time for a user who was invited,
   * pays the bonus to both sides and tells them. Never throws.
   */
  async function afterDelivery(bot, userId) {
    try {
      const r = await usage.referrals.confirmDelivered(userId);
      if (!r) return;

      await safeSend(
        bot,
        r.inviteeId,
        `🎁 چون با دعوت یکی از دوستانت وارد کوله شدی، ${formatNumber(r.inviteeBonus)} درخواست رایگان اضافه گرفتی! بعد از تموم شدن سهمیه‌ی هفتگی خرج می‌شه.`
      );

      const ref = r.referrer;
      if (!ref) return;
      const lines = [
        ref.bonusGranted
          ? `🎉 یکی از دوستانت با لینک تو اولین درخواستش رو انجام داد! ${formatNumber(ref.bonus)} درخواست رایگان اضافه گرفتی.`
          : "🎉 یکی از دوستانت با لینک تو اولین درخواستش رو انجام داد! (سقف پاداش درخواست رایگان پر شده، ولی این دعوت برای کوپن تخفیف حساب شد.)",
      ];
      if (ref.couponEarned) {
        lines.push(
          `🎟 یه کوپن ${pct()}٪ تخفیف اشتراک هم گرفتی! کوپن‌های آماده: ${formatNumber(ref.coupons)}. موقع خرید اشتراک خودکار اعمال می‌شه.`
        );
      } else {
        lines.push(`تا کوپن بعدی: ${formatNumber(config.REFERRALS_PER_COUPON - ref.progress)} دعوت موفق دیگه.`);
      }
      await safeSend(bot, ref.id, lines.join("\n"));
    } catch (err) {
      log.error(`[referral] afterDelivery failed for user ${userId}:`, err && err.message);
    }
  }

  return {
    sendInviteInfo,
    handleStartPayload,
    afterDelivery,
    inviteLink,
    setBotUsername(name) {
      if (name) botUsername = String(name).replace(/^@/, "");
    },
  };
}

const defaults = createReferralHandlers({ usage, config });

module.exports = { createReferralHandlers, ...defaults };

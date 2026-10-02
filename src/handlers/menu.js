const config = require("../config");
const { modes, MODES } = require("../services/userMode");
const { formatNumber } = require("../utils/format");
const { sendSubscriptionInfo } = require("./payment");
const { sendInviteInfo } = require("./referral");

// The persistent menu under the message box. Each label arrives as an ordinary
// text message when tapped, so bot.js checks isMenuLabel() before treating a
// text as "convert this to Word".
const MENU = {
  VOICE: "🎙 خلاصه پیام صوتی",
  VOICE_TO_TEXT: "🎙 تبدیل صدا به متن",
  PDF: "📄 خلاصه جزوه PDF",
  PDF_TO_TEXT: "📄 تبدیل متن PDF به متن",
  TRANSLATE: "🌐 ترجمه و ساده‌سازی متن",
  COMPRESS: "🗜 فشرده‌سازی عکس و PDF",
  SUBSCRIBE: "💳 خرید اشتراک",
  INVITE: "🎁 دعوت دوستان",
  TTS: "🔊 تبدیل متن به صدا",
  TEXT_TO_FILE: "📝 تبدیل متن به فایل",
};

const LABELS = new Set(Object.values(MENU));

function mainMenuKeyboard() {
  return {
    keyboard: [
      [MENU.VOICE, MENU.VOICE_TO_TEXT],
      [MENU.PDF, MENU.PDF_TO_TEXT],
      [MENU.TRANSLATE, MENU.COMPRESS],
      [MENU.TTS, MENU.TEXT_TO_FILE],
      [MENU.SUBSCRIBE, MENU.INVITE],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function isMenuLabel(text) {
  return LABELS.has(String(text).trim());
}

function voicePrompt() {
  const min = formatNumber(config.MIN_VOICE_DURATION_SECONDS);
  const max = formatNumber(Math.round(config.MAX_VOICE_DURATION_SECONDS / 60));
  return `پیام صوتیت رو بفرست (یا از یه چت دیگه فوروارد کن) تا خلاصه‌ش کنم 🎙\nمدتش باید بین ${min} ثانیه تا ${max} دقیقه باشه.`;
}

function voiceToTextPrompt() {
  const min = formatNumber(config.MIN_VOICE_DURATION_SECONDS);
  const max = formatNumber(Math.round(config.MAX_VOICE_DURATION_SECONDS / 60));
  return `پیام صوتیت رو بفرست تا کامل و بدون خلاصه‌سازی برات پیاده کنم 🎙\nمدتش باید بین ${min} ثانیه تا ${max} دقیقه باشه.`;
}

const PDF_PROMPT =
  "فایل PDF جزوه‌ات رو بفرست تا خلاصه‌ش کنم 📄\nPDF باید متن‌دار باشه (نه اسکن) و حداکثر ۲۰ مگابایت.";
const PDF_TO_TEXT_PROMPT =
  "فایل PDF رو بفرست تا متنش رو کامل و بدون خلاصه‌سازی به فایل Word تبدیل کنم 📄\nPDF باید متن‌دار باشه (نه اسکن) و حداکثر ۲۰ مگابایت.";
const TRANSLATE_PROMPT =
  "متنی که می‌خوای ترجمه بشه رو بفرست 🌐\nاگه فارسیه، به انگلیسی ترجمه‌ش می‌کنم و اگه انگلیسی (یا هر زبون دیگه‌ای) باشه، به فارسی روان و ساده برات برمی‌گردونم. زبان رو خودم تشخیص می‌دم.";
function ttsPrompt() {
  const max = formatNumber(config.TTS_TEXT_MAX_CHARS);
  return `متنی که می‌خوای به صدا تبدیل بشه رو بفرست 🔊\nحداکثر حدود ${max} کاراکتر (نزدیک ۶ دقیقه صدا) و همه‌ی متن رو توی یه پیام بفرست. این کار یه درخواست از سهمیه‌ات حساب می‌شه.`;
}
const COMPRESS_PROMPT = "عکس یا فایل PDF رو بفرست تا حجمش رو کم کنم 🗜";
const TEXT_TO_FILE_PROMPT =
  "متنی که می‌خوای به فایل Word تبدیل بشه رو بفرست 📝\nهمه‌ی متن رو توی یه پیام بفرست. این کار یه درخواست از سهمیه‌ات حساب می‌شه.";

/**
 * Handles a tap on a menu button. Buttons that need input (a text, a PDF, a
 * file) put the user in the matching mode so their next message runs that flow
 * directly; the voice button just asks for a voice message, which the voice
 * handler already picks up by itself.
 */
async function handleMenuButton(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  switch (String(msg.text).trim()) {
    case MENU.VOICE:
      modes.clear(userId);
      await bot.sendMessage(chatId, voicePrompt());
      return;
    case MENU.VOICE_TO_TEXT:
      modes.set(userId, MODES.VOICE_TO_TEXT);
      await bot.sendMessage(chatId, voiceToTextPrompt());
      return;
    case MENU.PDF:
      modes.set(userId, MODES.SUMMARIZE_PDF);
      await bot.sendMessage(chatId, PDF_PROMPT);
      return;
    case MENU.PDF_TO_TEXT:
      modes.set(userId, MODES.PDF_TO_TEXT);
      await bot.sendMessage(chatId, PDF_TO_TEXT_PROMPT);
      return;
    case MENU.TRANSLATE:
      modes.set(userId, MODES.TRANSLATE);
      await bot.sendMessage(chatId, TRANSLATE_PROMPT);
      return;
    case MENU.COMPRESS:
      modes.set(userId, MODES.COMPRESS);
      await bot.sendMessage(chatId, COMPRESS_PROMPT);
      return;
    case MENU.SUBSCRIBE:
      modes.clear(userId);
      await sendSubscriptionInfo(bot, chatId, userId);
      return;
    case MENU.INVITE:
      modes.clear(userId);
      await sendInviteInfo(bot, chatId, userId);
      return;
    case MENU.TTS:
      if (!config.TTS_ENABLED) {
        modes.clear(userId);
        await bot.sendMessage(chatId, "تبدیل متن به صدا فعلاً روی این بات فعال نیست.");
        return;
      }
      modes.set(userId, MODES.TTS_TEXT);
      await bot.sendMessage(chatId, ttsPrompt());
      return;
    case MENU.TEXT_TO_FILE:
      modes.set(userId, MODES.TEXT_TO_FILE);
      await bot.sendMessage(chatId, TEXT_TO_FILE_PROMPT);
      return;
    default:
      return;
  }
}

module.exports = { MENU, mainMenuKeyboard, isMenuLabel, handleMenuButton };

const config = require("../config");
const { synthesizeSpeech } = require("../services/tts");
const { createDailyCap } = require("../services/dailyCap");
const { formatNumber } = require("../utils/format");
const { gatePremiumFeature, releasePremiumFeature } = require("./payment");
const { afterDelivery } = require("./referral");

const AUDIO_BUTTON_TEXT = "🔊 دریافت نسخه صوتی";
const MAKING_AUDIO = "در حال ساخت نسخه صوتی...";
const BUSY = "یه نسخه صوتی از قبل در حال ساخته شدنه، چند لحظه صبر کن.";
const UNAVAILABLE = "نسخه صوتی فعلاً روی این بات فعال نیست.";
const AUDIO_ERROR = "ساخت نسخه صوتی با مشکل مواجه شد. دوباره امتحان کن.";

// Users not paying from the weekly quota (subscribers, or everyone while the
// database is down) are capped per day so audio stays bounded.
const dailyCap = createDailyCap({ limit: config.SUBSCRIBER_AUDIO_PER_DAY });
const inFlight = new Set(); // userIds with a conversion running

/** Extra inline-keyboard rows under a summary: the audio button, or none if audio is turned off. */
function audioButtonRows(sessionId) {
  return config.TTS_ENABLED ? [[{ text: AUDIO_BUTTON_TEXT, callback_data: `vs:tts:${sessionId}` }]] : [];
}

/**
 * The "🔊 دریافت نسخه صوتی" button: turns the summary of `session` into a voice
 * message. Opt-in and separate from the text summary, which was already
 * delivered. Every tap is a billable request (weekly free quota, or covered by a
 * subscription up to a daily cap) and is refunded if no audio is delivered.
 */
async function runAudioVersion(bot, callbackQuery, session, { synthesize = synthesizeSpeech } = {}) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;

  if (!config.TTS_ENABLED) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: UNAVAILABLE, show_alert: true });
    return;
  }

  if (inFlight.has(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: BUSY, show_alert: true });
    return;
  }
  inFlight.add(userId);

  let gate = null;
  let capped = false;
  let delivered = false;
  try {
    gate = await gatePremiumFeature(bot, chatId, userId);
    if (!gate) {
      await bot.answerCallbackQuery(callbackQuery.id); // the paywall was sent instead
      return;
    }

    if (!gate.counted) {
      if (!dailyCap.tryTake(userId)) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `به سقف ${formatNumber(dailyCap.limit)} نسخه‌ی صوتی در روز رسیدی. فردا دوباره امتحان کن 🙏`,
          show_alert: true,
        });
        return;
      }
      capped = true;
    }

    await bot.answerCallbackQuery(callbackQuery.id, { text: MAKING_AUDIO });
    bot.sendChatAction(chatId, "record_voice").catch(() => {});

    const audio = await synthesize(session.summary);
    await bot.sendVoice(chatId, audio, {}, { filename: "summary.ogg", contentType: "audio/ogg" });
    delivered = true;
  } catch (err) {
    console.error("Audio version failed:", { chatId, userId, error: err && err.message, stack: err && err.stack });
    await bot.sendMessage(chatId, AUDIO_ERROR).catch(() => {});
  } finally {
    if (gate && !delivered) {
      await releasePremiumFeature(userId, gate);
      if (capped) dailyCap.giveBack(userId);
    }
    inFlight.delete(userId);
  }

  if (delivered) afterDelivery(bot, userId).catch(() => {});
}

module.exports = { runAudioVersion, audioButtonRows, AUDIO_BUTTON_TEXT };

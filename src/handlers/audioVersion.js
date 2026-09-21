const config = require("../config");
const { synthesizeSpeech, prepareForSpeech } = require("../services/tts");
const { createDailyCap } = require("../services/dailyCap");
const { modes, MODES } = require("../services/userMode");
const { formatNumber } = require("../utils/format");
const { gatePremiumFeature, releasePremiumFeature } = require("./payment");
const { afterDelivery } = require("./referral");

const AUDIO_BUTTON_TEXT = "🔊 دریافت نسخه صوتی";
const MAKING_AUDIO = "در حال ساخت نسخه صوتی...";
const BUSY = "یه نسخه صوتی از قبل در حال ساخته شدنه، چند لحظه صبر کن.";
const UNAVAILABLE = "نسخه صوتی فعلاً روی این بات فعال نیست.";
const AUDIO_ERROR = "ساخت نسخه صوتی با مشکل مواجه شد. دوباره امتحان کن.";
const TTS_UNAVAILABLE = "تبدیل متن به صدا فعلاً روی این بات فعال نیست.";
const NOTHING_TO_SPEAK = "توی این متن چیزی برای خوندن پیدا نکردم. یه متن دیگه بفرست.";
const MAKING_SPEECH = "⏳ در حال تبدیل متن به صدا...";

// Users not paying from the weekly quota (subscribers, or everyone while the
// database is down) are capped per day so audio stays bounded. Shared by the
// summary audio button and the free-text "🔊 تبدیل متن به صدا".
const dailyCap = createDailyCap({ limit: config.SUBSCRIBER_AUDIO_PER_DAY });
const inFlight = new Set(); // userIds with a conversion running

const capMessage = () => `به سقف ${formatNumber(dailyCap.limit)} نسخه‌ی صوتی در روز رسیدی. فردا دوباره امتحان کن 🙏`;

/** Extra inline-keyboard rows under a summary: the audio button, or none if audio is turned off. */
function audioButtonRows(sessionId) {
  return config.TTS_ENABLED ? [[{ text: AUDIO_BUTTON_TEXT, callback_data: `vs:tts:${sessionId}` }]] : [];
}

/**
 * The one pipeline behind every audio feature: one conversion per user at a
 * time, a billable request (weekly free quota, or a subscription up to the
 * daily cap), synthesis, then a voice message, with the request refunded if no
 * audio is delivered. `onStart` runs right before synthesis (a toast, or a
 * "processing" message) and may return a cleanup function.
 *
 * Resolves "busy" | "paywall" | "capped" | "delivered" | "failed". "paywall"
 * means the paywall message was already sent; "failed" means the user was
 * already told; "busy" and "capped" leave the messaging to the caller.
 */
async function produceAudio(bot, { chatId, userId, text, filename, onStart, synthesize = synthesizeSpeech }) {
  if (inFlight.has(userId)) return "busy";
  inFlight.add(userId);

  let gate = null;
  let capped = false;
  let delivered = false;
  let cleanup = null;
  let status = "failed";
  try {
    gate = await gatePremiumFeature(bot, chatId, userId);
    if (!gate) return (status = "paywall");

    if (!gate.counted) {
      if (!dailyCap.tryTake(userId)) return (status = "capped");
      capped = true;
    }

    if (onStart) cleanup = await onStart();
    bot.sendChatAction(chatId, "record_voice").catch(() => {});

    const audio = await synthesize(text);
    await bot.sendVoice(chatId, audio, {}, { filename, contentType: "audio/ogg" });
    delivered = true;
    status = "delivered";
  } catch (err) {
    console.error("Audio generation failed:", { chatId, userId, error: err && err.message, stack: err && err.stack });
    await bot.sendMessage(chatId, AUDIO_ERROR).catch(() => {});
  } finally {
    if (gate && !delivered) {
      await releasePremiumFeature(userId, gate);
      if (capped) dailyCap.giveBack(userId);
    }
    if (cleanup) await Promise.resolve(cleanup()).catch(() => {});
    inFlight.delete(userId);
  }

  if (delivered) afterDelivery(bot, userId).catch(() => {});
  return status;
}

/**
 * The "🔊 دریافت نسخه صوتی" button: turns the summary of `session` into a voice
 * message. Opt-in and separate from the text summary, which was already
 * delivered. Every tap is a billable request and is refunded if no audio is
 * delivered.
 */
async function runAudioVersion(bot, callbackQuery, session, { synthesize } = {}) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;

  if (!config.TTS_ENABLED) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: UNAVAILABLE, show_alert: true });
    return;
  }

  let answered = false;
  const answer = (opts) => {
    answered = true;
    return bot.answerCallbackQuery(callbackQuery.id, opts);
  };

  const status = await produceAudio(bot, {
    chatId,
    userId,
    text: session.summary,
    filename: "summary.ogg",
    synthesize,
    onStart: () => answer({ text: MAKING_AUDIO }),
  });

  if (answered) return;
  if (status === "busy") await answer({ text: BUSY, show_alert: true });
  else if (status === "capped") await answer({ text: capMessage(), show_alert: true });
  else await answer(); // the paywall (or an error message) was sent instead; stop the spinner
}

function tooLongMessage(length) {
  const max = formatNumber(config.TTS_TEXT_MAX_CHARS);
  return `این متن برای تبدیل به صدا خیلی طولانیه (${formatNumber(length)} کاراکتر). حداکثر حدود ${max} کاراکتر می‌پذیرم که نزدیک ۶ دقیقه صدا می‌شه. متن رو کوتاه‌تر کن و دوباره بفرست.`;
}

/**
 * "🔊 تبدیل متن به صدا": reads the user's own text aloud as a voice message.
 * Same rules as the summary audio: a billable request (refunded on failure),
 * the subscriber daily cap, one conversion at a time. Text longer than
 * TTS_TEXT_MAX_CHARS is refused with the limit, and the user stays in the
 * "send me the text" step so they can resend a shorter one.
 */
async function runTextToSpeech(bot, chatId, userId, text, { synthesize } = {}) {
  if (!config.TTS_ENABLED) {
    await bot.sendMessage(chatId, TTS_UNAVAILABLE);
    return;
  }

  if (text.length > config.TTS_TEXT_MAX_CHARS) {
    modes.set(userId, MODES.TTS_TEXT);
    await bot.sendMessage(chatId, tooLongMessage(text.length));
    return;
  }

  if (!prepareForSpeech(text)) {
    modes.set(userId, MODES.TTS_TEXT);
    await bot.sendMessage(chatId, NOTHING_TO_SPEAK);
    return;
  }

  const status = await produceAudio(bot, {
    chatId,
    userId,
    text,
    filename: "speech.ogg",
    synthesize,
    onStart: async () => {
      const processing = await bot.sendMessage(chatId, MAKING_SPEECH);
      return () => (processing && processing.message_id ? bot.deleteMessage(chatId, processing.message_id) : undefined);
    },
  });

  if (status === "busy") await bot.sendMessage(chatId, BUSY);
  else if (status === "capped") await bot.sendMessage(chatId, capMessage());
}

module.exports = { runAudioVersion, runTextToSpeech, audioButtonRows, AUDIO_BUTTON_TEXT };

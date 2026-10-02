const config = require("../config");
const { downloadTelegramFile } = require("../services/telegramFile");
const { transcribeAudio } = require("../services/transcribe");
const { createSession } = require("../services/sessionStore");
const { checkAndRecordDailyUser, checkGlobalMinuteRate } = require("../services/rateLimiter");
const { GroqRateLimitError } = require("../services/groqClient");
const { chunkText } = require("../utils/textChunk");
const { gatePremiumFeature, releasePremiumFeature } = require("./payment");
const { afterDelivery } = require("./referral");

const PROCESSING_MESSAGE = "⏳ در حال پیاده‌سازی پیام صوتی... چند لحظه صبر کن.";
const DAILY_LIMIT_MESSAGE = "امروز به سقف تعداد پیام‌های صوتی رسیدی. فردا دوباره امتحان کن.";
const RATE_LIMIT_MESSAGE = "الان درخواست‌ها زیاده، چند لحظه دیگه دوباره امتحان کن 🙏";
const GENERIC_ERROR_MESSAGE =
  "یه مشکلی پیش اومد و نتونستم این پیام صوتی رو پیاده کنم. دوباره امتحان کن.";
const NO_GROQ_KEY_MESSAGE = "قابلیت پردازش پیام صوتی فعلاً روی این بات فعال نیست.";

function tooLongMessage(maxSeconds) {
  const minutes = Math.round(maxSeconds / 60);
  return `این پیام صوتی خیلی طولانیه 🙏 فعلاً فقط پیام‌های زیر ${minutes} دقیقه رو پردازش می‌کنم.`;
}

function tooShortMessage(minSeconds) {
  return `این پیام صوتی خیلی کوتاهه 🙏 برای تشخیص درست گفتار، لطفاً یه پیام صوتی حداقل ${minSeconds} ثانیه‌ای بفرست.`;
}

/**
 * "🎙 تبدیل صدا به متن": handles an incoming voice/audio message the same way
 * as the voice-summary flow (handlers/voice.js) up through transcription, but
 * skips summarization entirely and sends back the full, verbatim transcript
 * instead — split across multiple messages if it's too long for one (the same
 * chunkText() used for the "متن کامل" button elsewhere). Counts against the
 * weekly free quota and refunds it unless a transcript was actually delivered.
 */
async function runVoiceToText(bot, msg) {
  const media = msg.voice || msg.audio;
  if (!media) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!config.GROQ_API_KEY) {
    console.warn("Voice-to-text message received but GROQ_API_KEY is not set.");
    await bot.sendMessage(chatId, NO_GROQ_KEY_MESSAGE);
    return;
  }

  console.log("[voiceToText] received voice message", {
    chatId,
    userId,
    telegramReportedDurationSeconds: media.duration,
    telegramReportedFileSizeBytes: media.file_size,
    mimeType: media.mime_type,
  });

  if (media.duration > config.MAX_VOICE_DURATION_SECONDS) {
    await bot.sendMessage(chatId, tooLongMessage(config.MAX_VOICE_DURATION_SECONDS));
    return;
  }

  if (media.duration < config.MIN_VOICE_DURATION_SECONDS) {
    await bot.sendMessage(chatId, tooShortMessage(config.MIN_VOICE_DURATION_SECONDS));
    return;
  }

  const daily = checkAndRecordDailyUser(userId, config.DAILY_VOICE_LIMIT_PER_USER);
  if (!daily.allowed) {
    await bot.sendMessage(chatId, DAILY_LIMIT_MESSAGE);
    return;
  }

  if (!checkGlobalMinuteRate("whisper", config.GLOBAL_WHISPER_PER_MINUTE)) {
    await bot.sendMessage(chatId, RATE_LIMIT_MESSAGE);
    return;
  }

  // Weekly free-tier limit (subscribers are unlimited). Counted only once the
  // cheap validations above have passed, and refunded below unless the
  // transcript was actually delivered.
  const gate = await gatePremiumFeature(bot, chatId, userId);
  if (!gate) return;

  let succeeded = false;
  let processingMsg;
  try {
    processingMsg = await bot.sendMessage(chatId, PROCESSING_MESSAGE);
    await bot.sendChatAction(chatId, "typing");

    const { buffer } = await downloadTelegramFile(bot, media.file_id);
    const transcript = await transcribeAudio(buffer);
    if (!transcript || !transcript.trim()) {
      throw new Error("Empty transcript returned from Whisper");
    }

    // A "خروجی Word" button under the last chunk, reusing the existing
    // (free) session + docx mechanism — points straight at "docxfull" since
    // there's no separate summary to choose between.
    const sessionId = createSession({ userId, chatId, transcript });
    const chunks = chunkText(transcript);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const opts = isLast
        ? { reply_markup: { inline_keyboard: [[{ text: "خروجی Word", callback_data: `vs:docxfull:${sessionId}` }]] } }
        : undefined;
      await bot.sendMessage(chatId, chunks[i], opts);
    }

    succeeded = true;
    afterDelivery(bot, userId).catch(() => {});
  } catch (err) {
    console.error("Voice-to-text processing failed:", {
      chatId,
      userId,
      error: err && err.message,
      stack: err && err.stack,
    });

    const message = err instanceof GroqRateLimitError ? RATE_LIMIT_MESSAGE : GENERIC_ERROR_MESSAGE;
    await bot.sendMessage(chatId, message);
  } finally {
    if (!succeeded) await releasePremiumFeature(userId, gate);
    if (processingMsg) {
      bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    }
  }
}

module.exports = { runVoiceToText };

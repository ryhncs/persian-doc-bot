const config = require("../config");
const { downloadTelegramFile } = require("../services/telegramFile");
const { transcribeAudio } = require("../services/transcribe");
const { summarizeTranscript } = require("../services/summarize");
const { createSession } = require("../services/sessionStore");
const { checkAndRecordDailyUser, checkGlobalMinuteRate } = require("../services/rateLimiter");
const { GroqRateLimitError } = require("../services/groqClient");

const PROCESSING_MESSAGE = "⏳ در حال پردازش پیام صوتی... چند لحظه صبر کن.";
const DAILY_LIMIT_MESSAGE = "امروز به سقف تعداد پیام‌های صوتی رسیدی. فردا دوباره امتحان کن.";
const RATE_LIMIT_MESSAGE = "الان درخواست‌ها زیاده، چند لحظه دیگه دوباره امتحان کن 🙏";
const GENERIC_ERROR_MESSAGE =
  "یه مشکلی پیش اومد و نتونستم این پیام صوتی رو پردازش کنم. دوباره امتحان کن.";
const NO_GROQ_KEY_MESSAGE = "قابلیت پردازش پیام صوتی فعلاً روی این بات فعال نیست.";

function tooLongMessage(maxSeconds) {
  const minutes = Math.round(maxSeconds / 60);
  return `این پیام صوتی خیلی طولانیه 🙏 فعلاً فقط پیام‌های زیر ${minutes} دقیقه رو پردازش می‌کنم.`;
}

function tooShortMessage(minSeconds) {
  return `این پیام صوتی خیلی کوتاهه 🙏 برای تشخیص درست گفتار، لطفاً یه پیام صوتی حداقل ${minSeconds} ثانیه‌ای بفرست.`;
}

/**
 * Handles an incoming voice/audio message: download -> transcribe ->
 * summarize -> reply with the summary and "متن کامل" / "خروجی Word" buttons.
 */
async function handleVoiceMessage(bot, msg) {
  const media = msg.voice || msg.audio;
  if (!media) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!config.GROQ_API_KEY) {
    console.warn("Voice message received but GROQ_API_KEY is not set.");
    await bot.sendMessage(chatId, NO_GROQ_KEY_MESSAGE);
    return;
  }

  console.log("[voice] received voice message", {
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
    console.log("[voice] rejected: below minimum duration", {
      chatId,
      userId,
      durationSeconds: media.duration,
      minRequired: config.MIN_VOICE_DURATION_SECONDS,
    });
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

  let processingMsg;
  try {
    processingMsg = await bot.sendMessage(chatId, PROCESSING_MESSAGE);
    await bot.sendChatAction(chatId, "typing");

    const { buffer } = await downloadTelegramFile(bot, media.file_id);
    console.log("[voice] downloaded audio from Telegram", {
      downloadedBytes: buffer.length,
      telegramReportedFileSizeBytes: media.file_size,
      matchesReportedSize: media.file_size ? buffer.length === media.file_size : "unknown (not reported)",
    });

    const transcript = await transcribeAudio(buffer);
    if (!transcript || !transcript.trim()) {
      throw new Error("Empty transcript returned from Whisper");
    }

    if (!checkGlobalMinuteRate("llm", config.GLOBAL_LLM_PER_MINUTE)) {
      await bot.sendMessage(chatId, RATE_LIMIT_MESSAGE);
      return;
    }

    const summary = await summarizeTranscript(transcript);

    const sessionId = createSession({ userId, chatId, transcript, summary });

    console.log("[voice] sending summary reply...");
    await bot.sendMessage(chatId, summary, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "متن کامل", callback_data: `vs:full:${sessionId}` },
            { text: "خروجی Word", callback_data: `vs:docx:${sessionId}` },
          ],
        ],
      },
    });
  } catch (err) {
    console.error("Voice message processing failed:", {
      chatId,
      userId,
      error: err && err.message,
      stack: err && err.stack,
    });

    const message = err instanceof GroqRateLimitError ? RATE_LIMIT_MESSAGE : GENERIC_ERROR_MESSAGE;
    await bot.sendMessage(chatId, message);
  } finally {
    if (processingMsg) {
      bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    }
  }
}

module.exports = { handleVoiceMessage };

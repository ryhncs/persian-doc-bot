const config = require("../config");
const { createSession } = require("../services/sessionStore");
const { extractPdfText } = require("../services/pdfText");
const { summarizeLongDocument } = require("../services/longSummarize");
const { downloadTelegramFile } = require("../services/telegramFile");
const { GroqRateLimitError } = require("../services/groqClient");
const { checkGlobalMinuteRate } = require("../services/rateLimiter");
const { formatNumber } = require("../utils/format");
const { gatePremiumFeature, releasePremiumFeature } = require("./payment");
const { audioButtonRows } = require("./audioVersion");
const { afterDelivery } = require("./referral");

const PROCESSING_SUMMARY = "⏳ در حال استخراج و خلاصه‌سازی متن پی‌دی‌اف...";
const NO_TEXT_LAYER =
  "این پی‌دی‌اف ظاهراً اسکن‌شده و متن قابل‌استخراج نداره (تصویره، نه متن) — فعلاً فقط پی‌دی‌افای متنی رو می‌تونم خلاصه کنم.";
const TOO_LONG_FOR_SUMMARY =
  "این پی‌دی‌اف برای خلاصه‌سازی خیلی طولانیه. لطفاً چند بخش کوتاه‌تر ازش جدا کن و جدا جدا بفرست.";
const RATE_LIMIT_MESSAGE = "الان درخواست‌ها زیاده، چند لحظه دیگه دوباره امتحان کن 🙏";
const NO_GROQ_KEY_MESSAGE = "قابلیت خلاصه‌سازی فعلاً روی این بات فعال نیست.";
const SUMMARY_ERROR = "خلاصه‌سازی این پی‌دی‌اف با مشکل مواجه شد. دوباره امتحان کن.";

const PROGRESS_EDIT_INTERVAL_MS = 3000;

function formatEta(seconds) {
  if (seconds < 60) return "کمتر از یک دقیقه";
  return `حدود ${formatNumber(Math.ceil(seconds / 60))} دقیقه`;
}

function progressText({ stage, done, total, etaSeconds }) {
  const eta = `\nزمان باقی‌مونده: ${formatEta(etaSeconds)}`;
  if (stage === "map") {
    return `⏳ جزوه بلنده، پس تکه‌تکه خلاصه‌ش می‌کنم\nبخش ${formatNumber(done + 1)} از ${formatNumber(total)}${eta}`;
  }
  if (stage === "combine") {
    return `⏳ دارم خلاصه‌ی بخش‌ها رو کنار هم می‌ذارم (${formatNumber(done + 1)} از ${formatNumber(total)})${eta}`;
  }
  return `⏳ در حال نوشتن خلاصه‌ی نهایی...${eta}`;
}

// Edits the "processing" message as work advances, at most every few seconds
// and never with identical text (Telegram rejects both).
function createProgressEditor(bot, chatId, messageId, now = () => Date.now()) {
  let lastText = null;
  let lastAt = 0;
  return async (progress) => {
    const text = progressText(progress);
    if (text === lastText || now() - lastAt < PROGRESS_EDIT_INTERVAL_MS) return;
    lastText = text;
    lastAt = now();
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
    } catch {
      // Progress is cosmetic; never let a failed edit break the summary.
    }
  };
}

/**
 * Downloads a PDF by Telegram file_id, extracts its text and replies with a
 * Persian summary plus the usual "متن کامل"/"خروجی Word" buttons. Long
 * documents are summarized in chunks under the Groq tokens-per-minute budget
 * (see services/longSummarize.js), so this can take several minutes; the
 * processing message is updated as it goes. Counts against the weekly free
 * quota and refunds it unless a summary was actually delivered.
 */
async function runPdfSummary(bot, chatId, userId, fileId) {
  if (!config.GROQ_API_KEY) {
    await bot.sendMessage(chatId, NO_GROQ_KEY_MESSAGE);
    return;
  }

  const gate = await gatePremiumFeature(bot, chatId, userId);
  if (!gate) return;

  const processing = await bot.sendMessage(chatId, PROCESSING_SUMMARY);
  const editProgress = createProgressEditor(bot, chatId, processing && processing.message_id);

  let succeeded = false;
  try {
    const { buffer } = await downloadTelegramFile(bot, fileId);
    const { text } = await extractPdfText(buffer);

    if (!text || text.length < 20) {
      await bot.sendMessage(chatId, NO_TEXT_LAYER);
      return;
    }

    if (text.length > config.MAX_DOCUMENT_CHARS_FOR_SUMMARY) {
      await bot.sendMessage(chatId, TOO_LONG_FOR_SUMMARY);
      return;
    }

    if (!checkGlobalMinuteRate("llm", config.GLOBAL_LLM_PER_MINUTE)) {
      await bot.sendMessage(chatId, RATE_LIMIT_MESSAGE);
      return;
    }

    const { text: summary, calls, chunks } = await summarizeLongDocument(text, editProgress);
    console.log(`[pdfSummary] ${text.length} chars summarized in ${calls} calls over ${chunks} chunk(s)`);

    const newSessionId = createSession({ userId, chatId, transcript: text, summary });

    await bot.sendMessage(chatId, summary, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "متن کامل", callback_data: `vs:full:${newSessionId}` },
            { text: "خروجی Word", callback_data: `vs:docx:${newSessionId}` },
          ],
          ...audioButtonRows(newSessionId),
        ],
      },
    });
    succeeded = true;
    afterDelivery(bot, userId).catch(() => {});
  } catch (err) {
    console.error("PDF summarization failed:", {
      chatId,
      error: err && err.message,
      stack: err && err.stack,
    });
    const message = err instanceof GroqRateLimitError ? RATE_LIMIT_MESSAGE : SUMMARY_ERROR;
    await bot.sendMessage(chatId, message);
  } finally {
    if (!succeeded) await releasePremiumFeature(userId, gate);
    if (processing && processing.message_id) {
      bot.deleteMessage(chatId, processing.message_id).catch(() => {});
    }
  }
}

module.exports = { runPdfSummary, progressText };

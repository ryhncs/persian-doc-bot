const { getSession, createSession } = require("../services/sessionStore");
const { textToDocxBuffer } = require("../docGenerator");
const { chunkText } = require("../utils/textChunk");
const { extractPdfText } = require("../services/pdfText");
const { summarizeDocumentText } = require("../services/summarize");
const { downloadTelegramFile } = require("../services/telegramFile");
const { compressAndSendPdf } = require("./compress");
const { translateAndSimplify, translateToEnglish } = require("../services/translateSimplify");
const config = require("../config");
const { GroqRateLimitError } = require("../services/groqClient");
const { checkGlobalMinuteRate } = require("../services/rateLimiter");

const NOT_FOR_YOU = "این دکمه برای فایل/پیام صوتی خودت نیست.";
const EXPIRED = "این نشست منقضی شده. فایل یا پیام صوتی رو دوباره بفرست.";
const DOCX_ERROR = "ساخت فایل Word با مشکل مواجه شد. دوباره امتحان کن.";
const PROCESSING_SUMMARY = "⏳ در حال استخراج و خلاصه‌سازی متن پی‌دی‌اف...";
const NO_TEXT_LAYER =
  "این پی‌دی‌اف ظاهراً اسکن‌شده و متن قابل‌استخراج نداره (تصویره، نه متن) — فعلاً فقط پی‌دی‌افای متنی رو می‌تونم خلاصه کنم.";
const TOO_LONG_FOR_SUMMARY =
  "این پی‌دی‌اف برای خلاصه‌سازی خیلی طولانیه. لطفاً یه بخش کوتاه‌تر یا فصل جداگونه بفرست.";
const RATE_LIMIT_MESSAGE = "الان درخواست‌ها زیاده، چند لحظه دیگه دوباره امتحان کن 🙏";
const NO_GROQ_KEY_MESSAGE = "قابلیت خلاصه‌سازی فعلاً روی این بات فعال نیست.";
const SUMMARY_ERROR = "خلاصه‌سازی این پی‌دی‌اف با مشکل مواجه شد. دوباره امتحان کن.";
const PROCESSING_TRANSLATE_SIMPLIFY = "⏳ در حال ترجمه و ساده‌سازی...";
const PROCESSING_TO_ENGLISH = "⏳ در حال ترجمه به انگلیسی...";
const TRANSLATE_ERROR = "ترجمه/ساده‌سازی این متن با مشکل مواجه شد. دوباره امتحان کن.";

function checkOwnedSession(session, callbackQuery) {
  if (!session) return "expired";
  if (session.userId !== callbackQuery.from.id) return "not_owner";
  return null;
}

async function answerWithProblem(bot, callbackQuery, problem) {
  await bot.answerCallbackQuery(callbackQuery.id, {
    text: problem === "not_owner" ? NOT_FOR_YOU : EXPIRED,
    show_alert: true,
  });
}

/**
 * Handles the "متن کامل" / "خروجی Word" inline buttons attached to a
 * summary reply (voice or document — both funnel through the same
 * transcript/summary session shape). Session data is looked up by the short
 * id embedded in callback_data — see services/sessionStore.js.
 */
async function handleSummarySessionCallback(bot, callbackQuery, action, sessionId) {
  const chatId = callbackQuery.message.chat.id;
  const session = getSession(sessionId);

  const problem = checkOwnedSession(session, callbackQuery);
  if (problem) {
    await answerWithProblem(bot, callbackQuery, problem);
    return;
  }

  try {
    if (action === "full") {
      await bot.answerCallbackQuery(callbackQuery.id);
      for (const chunk of chunkText(session.transcript)) {
        await bot.sendMessage(chatId, chunk);
      }
      return;
    }

    if (action === "docx") {
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.sendMessage(chatId, "کدوم رو می‌خوای به Word تبدیل کنم؟", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "خلاصه", callback_data: `vs:docxsum:${sessionId}` },
              { text: "متن کامل", callback_data: `vs:docxfull:${sessionId}` },
            ],
          ],
        },
      });
      return;
    }

    if (action === "docxsum" || action === "docxfull") {
      await bot.answerCallbackQuery(callbackQuery.id, { text: "در حال ساخت فایل..." });

      const isSummary = action === "docxsum";
      const content = isSummary ? session.summary : session.transcript;
      const title = isSummary ? "خلاصه" : "متن کامل";

      const buffer = await textToDocxBuffer(content, title);

      await bot.sendDocument(
        chatId,
        buffer,
        {},
        {
          filename: isSummary ? "summary.docx" : "transcript.docx",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }
      );
      return;
    }
  } catch (err) {
    console.error("Callback query handling failed:", {
      chatId,
      action,
      error: err && err.message,
      stack: err && err.stack,
    });
    await bot.sendMessage(chatId, DOCX_ERROR);
  }
}

/**
 * Handles the "📝 خلاصه‌سازی" / "🗜 کم کردن حجم" buttons shown after a PDF is
 * sent (see handlers/compress.js handleDocumentMessage). The session here
 * only holds file metadata (fileId/fileName), not the file bytes — the PDF
 * is re-downloaded by file_id once the user picks an action, so nothing
 * large sits in memory while they're deciding (worth it on a free-tier
 * host; see technical-learnings on RAM limits).
 */
async function handleDocumentChoiceCallback(bot, callbackQuery, action, sessionId) {
  const chatId = callbackQuery.message.chat.id;
  const session = getSession(sessionId);

  const problem = checkOwnedSession(session, callbackQuery);
  if (problem) {
    await answerWithProblem(bot, callbackQuery, problem);
    return;
  }

  if (action === "compress") {
    await bot.answerCallbackQuery(callbackQuery.id);
    await compressAndSendPdf(bot, chatId, session.fileId, session.fileName);
    return;
  }

  if (action === "summarize") {
    if (!config.GROQ_API_KEY) {
      await bot.answerCallbackQuery(callbackQuery.id);
      await bot.sendMessage(chatId, NO_GROQ_KEY_MESSAGE);
      return;
    }

    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.sendMessage(chatId, PROCESSING_SUMMARY);

    try {
      const { buffer } = await downloadTelegramFile(bot, session.fileId);
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

      const summary = await summarizeDocumentText(text);
      const newSessionId = createSession({
        userId: session.userId,
        chatId,
        transcript: text,
        summary,
      });

      await bot.sendMessage(chatId, summary, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "متن کامل", callback_data: `vs:full:${newSessionId}` },
              { text: "خروجی Word", callback_data: `vs:docx:${newSessionId}` },
            ],
          ],
        },
      });
    } catch (err) {
      console.error("PDF summarization failed:", {
        chatId,
        error: err && err.message,
        stack: err && err.stack,
      });
      const message = err instanceof GroqRateLimitError ? RATE_LIMIT_MESSAGE : SUMMARY_ERROR;
      await bot.sendMessage(chatId, message);
    }
  }
}

/**
 * Handles both translation buttons shown under every text->docx reply (see
 * bot.js's text message handler): "🌐 ترجمه و ساده‌سازی (فارسی)"
 * (action "translate", any language -> Persian translation + simplified
 * version) and "🔁 ترجمه به انگلیسی" (action "toEnglish", typically
 * Persian -> plain English translation, no simplification). The session
 * here only holds the original text (no result yet); on success this
 * creates a *new* "vs:"-shaped session {transcript, summary} so the result
 * gets the same "متن اصلی"/"خروجی Word" buttons as the voice/PDF-summary
 * flows, reusing handleSummarySessionCallback rather than duplicating that
 * logic.
 */
async function handleTranslateCallback(bot, callbackQuery, action, sessionId) {
  if (action !== "translate" && action !== "toEnglish") return;

  const chatId = callbackQuery.message.chat.id;
  const session = getSession(sessionId);

  const problem = checkOwnedSession(session, callbackQuery);
  if (problem) {
    await answerWithProblem(bot, callbackQuery, problem);
    return;
  }

  if (!config.GROQ_API_KEY) {
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.sendMessage(chatId, NO_GROQ_KEY_MESSAGE);
    return;
  }

  if (!checkGlobalMinuteRate("llm", config.GLOBAL_LLM_PER_MINUTE)) {
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.sendMessage(chatId, RATE_LIMIT_MESSAGE);
    return;
  }

  await bot.answerCallbackQuery(callbackQuery.id);
  await bot.sendMessage(chatId, action === "toEnglish" ? PROCESSING_TO_ENGLISH : PROCESSING_TRANSLATE_SIMPLIFY);

  try {
    const result =
      action === "toEnglish"
        ? await translateToEnglish(session.transcript)
        : await translateAndSimplify(session.transcript);

    const newSessionId = createSession({
      userId: session.userId,
      chatId,
      transcript: session.transcript,
      summary: result,
    });

    await bot.sendMessage(chatId, result, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "متن اصلی", callback_data: `vs:full:${newSessionId}` },
            { text: "خروجی Word", callback_data: `vs:docx:${newSessionId}` },
          ],
        ],
      },
    });
  } catch (err) {
    console.error("Translate/simplify failed:", {
      chatId,
      action,
      error: err && err.message,
      stack: err && err.stack,
    });
    const message = err instanceof GroqRateLimitError ? RATE_LIMIT_MESSAGE : TRANSLATE_ERROR;
    await bot.sendMessage(chatId, message);
  }
}

async function handleCallbackQuery(bot, callbackQuery) {
  const data = callbackQuery.data || "";

  if (data.startsWith("vs:")) {
    const [, action, sessionId] = data.split(":");
    await handleSummarySessionCallback(bot, callbackQuery, action, sessionId);
    return;
  }

  if (data.startsWith("doc:")) {
    const [, action, sessionId] = data.split(":");
    await handleDocumentChoiceCallback(bot, callbackQuery, action, sessionId);
    return;
  }

  if (data.startsWith("txt:")) {
    const [, action, sessionId] = data.split(":");
    await handleTranslateCallback(bot, callbackQuery, action, sessionId);
    return;
  }
}

module.exports = { handleCallbackQuery };

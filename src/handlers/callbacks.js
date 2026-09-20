const { getSession } = require("../services/sessionStore");
const { textToDocxBuffer } = require("../docGenerator");
const { chunkText } = require("../utils/textChunk");
const { compressAndSendPdf } = require("./compress");
const { runPdfSummary } = require("./pdfSummary");
const { runTranslation } = require("./translate");
const { handlePaymentCallback } = require("./payment");

const NOT_FOR_YOU = "این دکمه برای فایل/پیام صوتی خودت نیست.";
const EXPIRED = "این نشست منقضی شده. فایل یا پیام صوتی رو دوباره بفرست.";
const DOCX_ERROR = "ساخت فایل Word با مشکل مواجه شد. دوباره امتحان کن.";

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
 * sent without having picked a menu button first (see handlers/compress.js
 * handleDocumentMessage). The session here only holds file metadata
 * (fileId/fileName), not the file bytes — the PDF is re-downloaded by file_id
 * once the user picks an action, so nothing large sits in memory while
 * they're deciding.
 */
async function handleDocumentChoiceCallback(bot, callbackQuery, action, sessionId) {
  const chatId = callbackQuery.message.chat.id;
  const session = getSession(sessionId);

  const problem = checkOwnedSession(session, callbackQuery);
  if (problem) {
    await answerWithProblem(bot, callbackQuery, problem);
    return;
  }

  await bot.answerCallbackQuery(callbackQuery.id);

  if (action === "compress") {
    await compressAndSendPdf(bot, chatId, session.fileId, session.fileName);
    return;
  }

  if (action === "summarize") {
    await runPdfSummary(bot, chatId, callbackQuery.from.id, session.fileId);
  }
}

/**
 * Handles both translation buttons shown under every text->docx reply (see
 * bot.js's text message handler): "🌐 ترجمه و ساده‌سازی (فارسی)"
 * (action "translate") and "🔁 ترجمه به انگلیسی" (action "toEnglish"). The
 * session only holds the original text; the work itself is shared with the
 * "🌐 ترجمه و ساده‌سازی متن" menu button (see handlers/translate.js).
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

  await bot.answerCallbackQuery(callbackQuery.id);
  await runTranslation(bot, chatId, callbackQuery.from.id, session.transcript, action);
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

  // Admin's "✅ تایید" / "❌ رد" buttons on a forwarded payment receipt.
  if (data.startsWith("pay:")) {
    const [, action, targetUserId] = data.split(":");
    await handlePaymentCallback(bot, callbackQuery, action, targetUserId);
    return;
  }
}

module.exports = { handleCallbackQuery };

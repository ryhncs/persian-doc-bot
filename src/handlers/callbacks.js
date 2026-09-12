const { getSession } = require("../services/sessionStore");
const { textToDocxBuffer } = require("../docGenerator");
const { chunkText } = require("../utils/textChunk");

const NOT_FOR_YOU = "این دکمه برای پیام صوتی خودت نیست.";
const EXPIRED = "این نشست منقضی شده. پیام صوتی رو دوباره بفرست.";
const DOCX_ERROR = "ساخت فایل Word با مشکل مواجه شد. دوباره امتحان کن.";

function checkOwnedSession(session, callbackQuery) {
  if (!session) return "expired";
  if (session.userId !== callbackQuery.from.id) return "not_owner";
  return null;
}

/**
 * Handles the "متن کامل" / "خروجی Word" inline buttons attached to a voice
 * summary reply. Session data (transcript/summary) is looked up by the short
 * id embedded in callback_data — see services/sessionStore.js.
 */
async function handleCallbackQuery(bot, callbackQuery) {
  const data = callbackQuery.data || "";
  if (!data.startsWith("vs:")) return;

  const [, action, sessionId] = data.split(":");
  const chatId = callbackQuery.message.chat.id;
  const session = getSession(sessionId);

  const problem = checkOwnedSession(session, callbackQuery);
  if (problem) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: problem === "not_owner" ? NOT_FOR_YOU : EXPIRED,
      show_alert: true,
    });
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
      const title = isSummary ? "خلاصه پیام صوتی" : "متن کامل پیام صوتی";

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

module.exports = { handleCallbackQuery };

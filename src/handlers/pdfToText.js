const { extractPdfText } = require("../services/pdfText");
const { downloadTelegramFile } = require("../services/telegramFile");
const { textToDocxBuffer } = require("../docGenerator");
const { gatePremiumFeature, releasePremiumFeature } = require("./payment");
const { afterDelivery } = require("./referral");

const PROCESSING = "⏳ در حال استخراج متن پی‌دی‌اف...";
const NO_TEXT_LAYER =
  "این پی‌دی‌اف ظاهراً اسکن‌شده و متن قابل‌استخراج نداره (تصویره، نه متن) — فعلاً فقط پی‌دی‌افای متن‌دار رو می‌تونم تبدیل کنم.";
const GENERIC_ERROR = "استخراج متن این پی‌دی‌اف با مشکل مواجه شد. دوباره امتحان کن.";

/**
 * "📄 تبدیل متن PDF به متن": downloads a PDF by Telegram file_id, extracts its
 * full text (no summarization — unlike handlers/pdfSummary.js) and always
 * sends it back as a Word file, reusing the same text-to-docx mechanism as
 * everywhere else in the bot (docGenerator.js). No Groq/LLM call at all, so
 * unlike the summary flow there's no token-budget length cap. Counts against
 * the weekly free quota and refunds it unless a file was actually delivered.
 */
async function runPdfToText(bot, chatId, userId, fileId, fileName) {
  const gate = await gatePremiumFeature(bot, chatId, userId);
  if (!gate) return;

  const processing = await bot.sendMessage(chatId, PROCESSING);

  let succeeded = false;
  try {
    await bot.sendChatAction(chatId, "upload_document");

    const { buffer } = await downloadTelegramFile(bot, fileId);
    const { text } = await extractPdfText(buffer);

    if (!text || text.length < 20) {
      await bot.sendMessage(chatId, NO_TEXT_LAYER);
      return;
    }

    const docxBuffer = await textToDocxBuffer(text, "متن استخراج‌شده");

    await bot.sendDocument(
      chatId,
      docxBuffer,
      {},
      {
        filename: fileName ? `${fileName.replace(/\.pdf$/i, "")}.docx` : "extracted-text.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }
    );

    succeeded = true;
    afterDelivery(bot, userId).catch(() => {});
  } catch (err) {
    console.error("PDF-to-text failed:", { chatId, error: err && err.message, stack: err && err.stack });
    await bot.sendMessage(chatId, GENERIC_ERROR);
  } finally {
    if (!succeeded) await releasePremiumFeature(userId, gate);
    if (processing && processing.message_id) {
      bot.deleteMessage(chatId, processing.message_id).catch(() => {});
    }
  }
}

module.exports = { runPdfToText };

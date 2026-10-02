const { textToDocxBuffer } = require("../docGenerator");
const { gatePremiumFeature, releasePremiumFeature } = require("./payment");
const { afterDelivery } = require("./referral");

const PROCESSING = "⏳ در حال ساخت فایل...";
const GENERIC_ERROR = "ساخت فایل با مشکل مواجه شد. دوباره امتحان کن.";

/**
 * "📝 تبدیل متن به فایل": exports arbitrary text as a downloadable file.
 * Word (.docx) only for now — the same mechanism already used everywhere
 * else in the bot (docGenerator.js). A PDF option was considered but every
 * lightweight approach garbles mixed Persian/English text (the model this
 * bot's own summaries produce), and a correct one needs headless Chromium,
 * which is real added weight/cost; revisit if that trade-off changes.
 *
 * Unlike the free plain-text-to-Word flow in bot.js, this is an explicit,
 * billable action reached only via the menu button — it counts against the
 * weekly free quota and refunds it unless a file was actually delivered.
 */
async function runTextToFile(bot, chatId, userId, text) {
  const gate = await gatePremiumFeature(bot, chatId, userId);
  if (!gate) return;

  const processing = await bot.sendMessage(chatId, PROCESSING);

  let succeeded = false;
  try {
    await bot.sendChatAction(chatId, "upload_document");

    const buffer = await textToDocxBuffer(text);

    await bot.sendDocument(
      chatId,
      buffer,
      {},
      {
        filename: "document.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }
    );

    succeeded = true;
    afterDelivery(bot, userId).catch(() => {});
  } catch (err) {
    console.error("Text-to-file failed:", { chatId, error: err && err.message, stack: err && err.stack });
    await bot.sendMessage(chatId, GENERIC_ERROR);
  } finally {
    if (!succeeded) await releasePremiumFeature(userId, gate);
    if (processing && processing.message_id) {
      bot.deleteMessage(chatId, processing.message_id).catch(() => {});
    }
  }
}

module.exports = { runTextToFile };

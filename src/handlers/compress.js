const { downloadTelegramFile } = require("../services/telegramFile");
const { compressImage } = require("../services/imageCompress");
const { compressPdf } = require("../services/pdfCompress");

const PROCESSING = "⏳ در حال فشرده‌سازی فایل...";
const GENERIC_ERROR = "فشرده‌سازی فایل با مشکل مواجه شد. دوباره امتحان کن.";
const GS_MISSING_ERROR =
  "فشرده‌سازی پی‌دی‌اف روی این سرور فعال نیست (Ghostscript نصب نشده). به مدیر ربات اطلاع بده.";
const UNSUPPORTED_DOC =
  "فعلاً فقط فایل‌های پی‌دی‌اف رو می‌تونم فشرده کنم. عکس رو هم می‌تونی مستقیم (بدون فشرده‌سازی دستی) بفرستی.";
const TOO_LARGE =
  "فایل باید کمتر از ۲۰ مگابایت باشه — این محدودیت تلگرامه برای دانلود فایل توسط ربات‌ها.";

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} مگابایت`;
}

async function sendCompressedResult(bot, chatId, originalSize, resultBuffer, filename, contentType) {
  const savedPercent = Math.max(0, Math.round((1 - resultBuffer.length / originalSize) * 100));

  const caption =
    savedPercent > 0
      ? `حجم از ${formatSize(originalSize)} به ${formatSize(resultBuffer.length)} رسید (${savedPercent}٪ کاهش).`
      : "فایل از قبل فشرده بود — تغییر محسوسی توی حجمش ایجاد نشد.";

  await bot.sendDocument(chatId, resultBuffer, { caption }, { filename, contentType });
}

/**
 * Handles an incoming photo message: downloads Telegram's largest available
 * size, re-compresses it with sharp, and sends the result back as a
 * *document* (not a photo) so Telegram doesn't silently re-compress it
 * again on the way out.
 */
async function handlePhotoMessage(bot, msg) {
  const chatId = msg.chat.id;

  try {
    // msg.photo is an array of sizes; the last one is the largest.
    const sizes = msg.photo;
    const largest = sizes[sizes.length - 1];

    await bot.sendChatAction(chatId, "upload_document");
    await bot.sendMessage(chatId, PROCESSING);

    const { buffer } = await downloadTelegramFile(bot, largest.file_id);
    const { buffer: compressed } = await compressImage(buffer);

    await sendCompressedResult(bot, chatId, buffer.length, compressed, "compressed.jpg", "image/jpeg");
  } catch (err) {
    console.error("Image compression failed:", err);
    await bot.sendMessage(chatId, GENERIC_ERROR);
  }
}

/**
 * Handles an incoming document message. Only PDFs are compressed for now —
 * anything else gets a friendly "not supported yet" reply rather than being
 * silently ignored.
 */
async function handleDocumentMessage(bot, msg) {
  const chatId = msg.chat.id;
  const doc = msg.document;

  if (doc.mime_type !== "application/pdf") {
    await bot.sendMessage(chatId, UNSUPPORTED_DOC);
    return;
  }

  if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
    await bot.sendMessage(chatId, TOO_LARGE);
    return;
  }

  try {
    await bot.sendChatAction(chatId, "upload_document");
    await bot.sendMessage(chatId, PROCESSING);

    const { buffer } = await downloadTelegramFile(bot, doc.file_id);
    const compressed = await compressPdf(buffer);

    await sendCompressedResult(
      bot,
      chatId,
      buffer.length,
      compressed,
      doc.file_name ? `compressed-${doc.file_name}` : "compressed.pdf",
      "application/pdf"
    );
  } catch (err) {
    console.error("PDF compression failed:", err);
    const isMissingGhostscript = err && err.code === "ENOENT";
    await bot.sendMessage(chatId, isMissingGhostscript ? GS_MISSING_ERROR : GENERIC_ERROR);
  }
}

module.exports = { handlePhotoMessage, handleDocumentMessage };

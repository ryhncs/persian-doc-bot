const { downloadTelegramFile } = require("../services/telegramFile");
const { compressImage } = require("../services/imageCompress");
const { compressPdf } = require("../services/pdfCompress");
const { createSession } = require("../services/sessionStore");

const PROCESSING = "⏳ در حال فشرده‌سازی فایل...";
const GENERIC_ERROR = "فشرده‌سازی فایل با مشکل مواجه شد. دوباره امتحان کن.";
const GS_MISSING_ERROR =
  "فشرده‌سازی پی‌دی‌اف روی این سرور فعال نیست (Ghostscript نصب نشده). به مدیر ربات اطلاع بده.";
const UNSUPPORTED_DOC =
  "فعلاً فقط فایل‌های پی‌دی‌اف رو می‌تونم پردازش کنم. عکس رو هم می‌تونی مستقیم (بدون فشرده‌سازی دستی) بفرستی.";
const TOO_LARGE =
  "فایل باید کمتر از ۲۰ مگابایت باشه — این محدودیت تلگرامه برای دانلود فایل توسط ربات‌ها.";
const CHOOSE_ACTION = "این پی‌دی‌اف رو چیکارش کنم؟";

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
 * Downloads a PDF by Telegram file_id, compresses it with Ghostscript, and
 * sends the result back. Split out from handleDocumentMessage so it can be
 * called both there (not currently — see below) and from the "🗜 کم کردن
 * حجم" callback button in handlers/callbacks.js, since a PDF's file_id is
 * still valid by the time the user picks an action.
 */
async function compressAndSendPdf(bot, chatId, fileId, fileName) {
  try {
    await bot.sendChatAction(chatId, "upload_document");
    await bot.sendMessage(chatId, PROCESSING);

    const { buffer } = await downloadTelegramFile(bot, fileId);
    const compressed = await compressPdf(buffer);

    await sendCompressedResult(
      bot,
      chatId,
      buffer.length,
      compressed,
      fileName ? `compressed-${fileName}` : "compressed.pdf",
      "application/pdf"
    );
  } catch (err) {
    console.error("PDF compression failed:", err);
    const isMissingGhostscript = err && err.code === "ENOENT";
    await bot.sendMessage(chatId, isMissingGhostscript ? GS_MISSING_ERROR : GENERIC_ERROR);
  }
}

/**
 * Handles an incoming document message. Only PDFs are supported for now —
 * anything else gets a friendly "not supported yet" reply rather than being
 * silently ignored. A PDF isn't acted on immediately: since the bot can
 * both compress a PDF and (student-assistant feature) summarize one, the
 * user is asked which they want via inline buttons — see
 * handlers/callbacks.js for the "doc:summarize" / "doc:compress" handling.
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

  const sessionId = createSession({
    userId: msg.from.id,
    chatId,
    fileId: doc.file_id,
    fileName: doc.file_name,
  });

  await bot.sendMessage(chatId, CHOOSE_ACTION, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📝 خلاصه‌سازی", callback_data: `doc:summarize:${sessionId}` },
          { text: "🗜 کم کردن حجم", callback_data: `doc:compress:${sessionId}` },
        ],
      ],
    },
  });
}

module.exports = { handlePhotoMessage, handleDocumentMessage, compressAndSendPdf };

/**
 * Downloads a Telegram-hosted file (e.g. a voice note) by file_id and
 * returns it as a Buffer.
 */
async function downloadTelegramFile(bot, fileId) {
  const fileUrl = await bot.getFileLink(fileId);

  const res = await fetch(fileUrl, { signal: AbortSignal.timeout(60 * 1000) });
  if (!res.ok) {
    throw new Error(`Failed to download Telegram file (HTTP ${res.status})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer) };
}

module.exports = { downloadTelegramFile };

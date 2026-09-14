const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Splits text into chunks no longer than maxLength, preferring to break on
 * paragraph/line/word boundaries so it doesn't cut mid-word.
 */
function chunkText(text, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt <= 0) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);

  return chunks;
}

module.exports = { chunkText };

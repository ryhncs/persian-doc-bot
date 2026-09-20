// Splits text into consecutive chunks of at most maxChars, preferring to break
// on line ends, then sentence ends, then (only for a single enormous
// sentence) on spaces. Nothing is dropped except blank lines and surrounding
// whitespace, so summarizing every chunk covers the whole document.

const SENTENCE_BREAK = /(?<=[.!?؟۔؛])\s+/;

function hardSplit(str, maxChars) {
  const pieces = [];
  let current = "";
  for (const word of str.split(/\s+/)) {
    if (word.length > maxChars) {
      // A single "word" longer than a chunk (e.g. a URL or a run of digits).
      if (current) pieces.push(current);
      current = "";
      for (let i = 0; i < word.length; i += maxChars) pieces.push(word.slice(i, i + maxChars));
    } else if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      pieces.push(current);
      current = word;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function splitIntoChunks(text, maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");

  const units = [];
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.length <= maxChars) {
      units.push(line);
      continue;
    }
    for (const sentence of line.split(SENTENCE_BREAK)) {
      if (sentence.length <= maxChars) units.push(sentence);
      else units.push(...hardSplit(sentence, maxChars));
    }
  }

  const chunks = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
    } else if (current.length + 1 + unit.length <= maxChars) {
      current += `\n${unit}`;
    } else {
      chunks.push(current);
      current = unit;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = { splitIntoChunks };

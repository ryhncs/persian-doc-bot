const { Document, Packer, Paragraph, TextRun, AlignmentType } = require("docx");

const FA_FONT = "Vazirmatn";
const EN_FONT = "Poppins";

/**
 * Detects whether a string contains Persian/Arabic-script characters.
 * Mixed-language lines are still rendered RTL (the dominant reading direction),
 * but the font per run is chosen based on this check where it matters.
 */
function hasPersianChars(text) {
  return /[\u0600-\u06FF]/.test(text);
}

/**
 * Cleans up messy pasted text:
 * - normalizes Windows/Mac line endings
 * - collapses 3+ blank lines into a single paragraph break
 * - trims trailing spaces on each line
 * - splits into paragraphs on blank lines
 */
function cleanAndSplit(rawText) {
  const normalized = rawText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const blankLineBlocks = normalized
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\n/g, " ").trim())
    .filter((block) => block.length > 0);

  const hasMultipleLines = normalized.split("\n").length > 1;

  if (blankLineBlocks.length > 1 || !hasMultipleLines) {
    return blankLineBlocks;
  }

  // Fallback: no blank lines were found, but there are multiple lines —
  // most likely blank lines got stripped in transit. Treat each line as
  // its own paragraph so content doesn't get silently merged.
  return normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Builds a single RTL paragraph, picking the font per-run so Persian
 * and English fragments both render correctly.
 */
function buildParagraph(text) {
  const font = hasPersianChars(text) ? FA_FONT : EN_FONT;

  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    bidirectional: true, // paragraph-level RTL flag
    spacing: { after: 200, line: 320 },
    children: [
      new TextRun({
        text,
        font,
        size: 24, // 12pt (docx sizes are in half-points)
        rightToLeft: true, // NOTE: correct property name — NOT `rtl`
      }),
    ],
  });
}

/**
 * Converts raw pasted text into a Buffer containing a formatted .docx file.
 * @param {string} rawText - the messy text the user sent
 * @param {string} [title] - optional heading to place at the top
 * @returns {Promise<Buffer>}
 */
async function textToDocxBuffer(rawText, title) {
  const paragraphs = cleanAndSplit(rawText);

  const children = [];

  if (title && title.trim().length > 0) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        bidirectional: true,
        spacing: { after: 300 },
        children: [
          new TextRun({
            text: title.trim(),
            font: hasPersianChars(title) ? FA_FONT : EN_FONT,
            bold: true,
            size: 32, // 16pt
            rightToLeft: true,
          }),
        ],
      })
    );
  }

  for (const block of paragraphs) {
    children.push(buildParagraph(block));
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

module.exports = { textToDocxBuffer, cleanAndSplit, hasPersianChars };

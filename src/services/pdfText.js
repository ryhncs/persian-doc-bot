const pdfParse = require("pdf-parse");

/**
 * Extracts plain text from a PDF buffer using pdf-parse (pure JS, no native
 * binary — separate from pdfCompress.js, which shells out to Ghostscript).
 * Works for PDFs with a real text layer; a scanned PDF with no text layer
 * will come back with an empty/near-empty string, which callers should
 * treat as "nothing to summarize" rather than retrying.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{text: string, numPages: number}>}
 */
async function extractPdfText(buffer) {
  const result = await pdfParse(buffer);
  return {
    text: (result.text || "").trim(),
    numPages: result.numpages || 0,
  };
}

module.exports = { extractPdfText };

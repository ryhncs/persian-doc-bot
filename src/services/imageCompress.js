const sharp = require("sharp");

const DEFAULT_QUALITY = 70;
const MIN_QUALITY = 35;
const QUALITY_STEP = 10;

/**
 * Compresses an image buffer with sharp: respects EXIF rotation, caps the
 * width so huge phone photos get downscaled, and re-encodes as JPEG at a
 * quality that keeps output visually close to the original. If a
 * targetBytes is given, steps quality down (never below MIN_QUALITY) until
 * the output fits, or it runs out of room to cut further.
 *
 * @param {Buffer} inputBuffer - original image bytes (any format sharp reads)
 * @param {object} [opts]
 * @param {number} [opts.maxWidth=1920] - downscale if wider than this (keeps aspect ratio)
 * @param {number} [opts.targetBytes] - optional size budget in bytes
 * @returns {Promise<{buffer: Buffer, format: string, quality: number}>}
 */
async function compressImage(inputBuffer, opts = {}) {
  const { maxWidth = 1920, targetBytes } = opts;

  let quality = DEFAULT_QUALITY;
  let outputBuffer;

  do {
    outputBuffer = await sharp(inputBuffer)
      .rotate() // apply EXIF orientation before resizing so it isn't lost
      .resize({ width: maxWidth, withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    if (!targetBytes || outputBuffer.length <= targetBytes || quality <= MIN_QUALITY) {
      break;
    }
    quality -= QUALITY_STEP;
  } while (quality >= MIN_QUALITY);

  return { buffer: outputBuffer, format: "jpeg", quality };
}

module.exports = { compressImage };

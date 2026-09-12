const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Transcodes an OGG/OPUS buffer (Telegram's voice note format) to MP3.
 * Used as a fallback when Groq's Whisper endpoint rejects the raw upload.
 */
async function convertOggToMp3(inputBuffer) {
  const tmpId = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(os.tmpdir(), `voicesum-${tmpId}.oga`);
  const outputPath = path.join(os.tmpdir(), `voicesum-${tmpId}.mp3`);

  await fs.writeFile(inputPath, inputBuffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec("libmp3lame")
        .format("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(inputPath, { force: true });
    await fs.rm(outputPath, { force: true });
  }
}

module.exports = { convertOggToMp3 };

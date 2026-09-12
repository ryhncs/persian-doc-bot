const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Transcodes an OGG/OPUS buffer (Telegram's voice note format) to 16kHz
 * mono PCM WAV. Used as a fallback when Groq's Whisper endpoint rejects the
 * raw upload.
 *
 * WAV/PCM instead of MP3: Whisper's own preprocessing resamples every input
 * to 16kHz mono before transcribing, so encoding to a lossy codec here
 * (MP3) only stacks a second generation of lossy compression on top of the
 * original opus compression, degrading audio the model never asked for at
 * a quality it can't use anyway. Going straight to the sample
 * rate/channel count Whisper actually consumes, losslessly, avoids that.
 */
async function convertOggToWav(inputBuffer) {
  const tmpId = crypto.randomBytes(6).toString("hex");
  const inputPath = path.join(os.tmpdir(), `voicesum-${tmpId}.oga`);
  const outputPath = path.join(os.tmpdir(), `voicesum-${tmpId}.wav`);

  await fs.writeFile(inputPath, inputBuffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .format("wav")
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

module.exports = { convertOggToWav };

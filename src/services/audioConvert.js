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

    const wavBuffer = await fs.readFile(outputPath);

    // Sanity check: 16kHz mono 16-bit PCM is exactly 32000 bytes/sec of
    // audio data (44-byte WAV header excluded). Logging the implied
    // duration alongside byte size makes a truncated/near-empty
    // conversion (ffmpeg silently failing partway through, disk-full,
    // etc.) visible in the logs without needing to pull the file itself.
    const dataBytes = Math.max(0, wavBuffer.length - 44);
    const impliedSeconds = dataBytes / (16000 * 2);
    console.log(
      `[audioConvert] wav output: ${wavBuffer.length} bytes ` +
        `(~${impliedSeconds.toFixed(2)}s of 16kHz mono PCM16 audio)`
    );
    if (dataBytes <= 0) {
      console.warn(
        "[audioConvert] converted WAV has no audio data beyond the header " +
          "— likely a silent/failed ffmpeg conversion"
      );
    }

    return wavBuffer;
  } finally {
    await fs.rm(inputPath, { force: true });
    await fs.rm(outputPath, { force: true });
  }
}

module.exports = { convertOggToWav };

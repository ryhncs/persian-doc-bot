const config = require("../config");
const { groqFetch, GroqApiError } = require("./groqClient");
const { convertOggToMp3 } = require("./audioConvert");

async function callWhisper(buffer, filename, mimeType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  form.append("model", config.WHISPER_MODEL);
  form.append("response_format", "json");

  return groqFetch("/audio/transcriptions", {
    method: "POST",
    body: form,
  });
}

/**
 * Transcribes an audio buffer via Groq's Whisper endpoint. Telegram voice
 * notes arrive as OGG/OPUS. Groq's Whisper endpoint generally accepts OGG
 * directly, but if it rejects the format (4xx, not a rate limit) we
 * transcode to MP3 with ffmpeg and retry once.
 */
async function transcribeAudio(buffer, filename = "voice.ogg") {
  try {
    console.log(`[transcribe] uploading ${buffer.length} bytes as ${filename}...`);
    const result = await callWhisper(buffer, filename, "audio/ogg");
    console.log("[transcribe] whisper (raw) succeeded");
    return result.text;
  } catch (err) {
    const isFormatIssue =
      err instanceof GroqApiError && err.status >= 400 && err.status < 500 && err.status !== 429;

    if (!isFormatIssue) {
      throw err;
    }

    console.warn("Groq rejected the raw OGG upload, retrying after ffmpeg conversion:", err.message);
    console.log("[transcribe] converting to mp3...");
    const mp3Buffer = await convertOggToMp3(buffer);
    console.log(`[transcribe] converted, uploading ${mp3Buffer.length} bytes as voice.mp3...`);
    const result = await callWhisper(mp3Buffer, "voice.mp3", "audio/mpeg");
    console.log("[transcribe] whisper (mp3 retry) succeeded");
    return result.text;
  }
}

module.exports = { transcribeAudio };

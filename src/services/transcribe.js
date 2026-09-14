const config = require("../config");
const { groqFetch, GroqApiError } = require("./groqClient");
const { convertOggToWav } = require("./audioConvert");
const { buildWhisperPrompt } = require("./whisperPrompt");

async function callWhisper(buffer, filename, mimeType) {
  const prompt = buildWhisperPrompt();
  const model = config.WHISPER_MODEL;
  const language = "fa";
  const temperature = "0";

  // Dump every param actually going to Groq right before the call, so a
  // bad transcription can be checked against what was really sent (e.g.
  // ruling out a corrupted/oversized prompt, wrong model, or a field
  // silently clobbering another) instead of just what the code intends.
  console.log("[transcribe] groq request", {
    model,
    language,
    temperature,
    promptByteLength: Buffer.byteLength(prompt, "utf8"),
    fileField: { filename, mimeType, bytes: buffer.length },
  });

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  form.append("model", model);
  form.append("response_format", "json");
  form.append("prompt", prompt);
  // Voice messages are Persian (with code-switched English) — pinning the
  // language skips Whisper's auto-detection, which otherwise regularly
  // misfires on short/mixed-language clips and visibly hurts accuracy even
  // on the pure-Persian portions.
  form.append("language", language);
  // Deterministic decoding: temperature 0 always takes Whisper's
  // highest-probability token instead of sampling, which avoids
  // "creative"/hallucinated wording on unclear audio.
  form.append("temperature", temperature);

  return groqFetch("/audio/transcriptions", {
    method: "POST",
    body: form,
  });
}

/**
 * Transcribes an audio buffer via Groq's Whisper endpoint. Telegram voice
 * notes arrive as OGG/OPUS. Groq's Whisper endpoint generally accepts OGG
 * directly, but if it rejects the format (4xx, not a rate limit) we
 * transcode to WAV with ffmpeg and retry once.
 *
 * The fallback converts to 16kHz mono PCM WAV rather than MP3: that's
 * lossless and matches the sample rate/channel count Whisper's own
 * preprocessing resamples everything to internally anyway, so it avoids
 * stacking a second lossy codec (opus -> mp3) on top of the original
 * opus compression for no benefit.
 */
async function transcribeAudio(buffer, filename = "voice.ogg") {
  try {
    console.log(`[transcribe] path=raw-ogg uploading ${buffer.length} bytes as ${filename}...`);
    const result = await callWhisper(buffer, filename, "audio/ogg");
    console.log("[transcribe] path=raw-ogg succeeded, text:", JSON.stringify(result.text));
    return result.text;
  } catch (err) {
    const isFormatIssue =
      err instanceof GroqApiError && err.status >= 400 && err.status < 500 && err.status !== 429;

    if (!isFormatIssue) {
      throw err;
    }

    console.warn(
      "[transcribe] path=raw-ogg rejected by Groq, falling back to ffmpeg wav conversion:",
      err.message
    );
    const wavBuffer = await convertOggToWav(buffer);
    console.log(`[transcribe] path=ffmpeg-fallback-wav uploading ${wavBuffer.length} bytes as voice.wav...`);
    const result = await callWhisper(wavBuffer, "voice.wav", "audio/wav");
    console.log("[transcribe] path=ffmpeg-fallback-wav succeeded, text:", JSON.stringify(result.text));
    return result.text;
  }
}

module.exports = { transcribeAudio };

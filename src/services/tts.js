// Text to speech for the "🔊 دریافت نسخه صوتی" button.
//
// Uses Microsoft Edge's read-aloud endpoint through the edge-tts-universal
// package: free, no API key, Persian voices (fa-IR-DilaraNeural / -FaridNeural).
// It is an UNOFFICIAL endpoint (accepted risk): it can change or be blocked
// without notice, in which case synthesizeSpeech() throws and the caller
// refunds the request. To move to a paid provider (e.g. Azure Speech, same
// voices) only this file's synthesizeSpeech() needs to change.
//
// The endpoint returns MP3; Telegram voice notes must be OGG/Opus, so the MP3
// is transcoded with the ffmpeg the bot already ships (audioConvert.js).

const config = require("../config");
const { convertToOggOpus } = require("./audioConvert");

// Generous for a summary (a few thousand characters); anything longer is
// refused instead of tying up the synthesizer for minutes.
const MAX_SPEECH_CHARS = 12000;
const SYNTHESIS_TIMEOUT_MS = 60 * 1000;

// Pictographs and other symbols the voice would skip or stumble on.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
const BULLET_RE = /^\s*(?:[-*•●▪–—]|\d+[.)])\s+/;
const SENTENCE_END_RE = /[.!?؟،؛:;…]$/;

/**
 * Turns a summary (bullet lines with "- ", emoji, markdown) into text that reads
 * well aloud: one sentence per line, every line ends with punctuation so the
 * voice pauses, and no symbols to stumble on.
 */
function prepareForSpeech(text) {
  const lines = String(text)
    .replace(EMOJI_RE, "")
    .replace(/[*_`#>]+/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(BULLET_RE, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return lines.map((line) => (SENTENCE_END_RE.test(line) ? line : `${line}.`)).join("\n");
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Loaded lazily: the package pulls in a websocket stack that nothing else needs.
async function edgeSynthesize(text, voice) {
  const { EdgeTTS } = require("edge-tts-universal");
  const result = await new EdgeTTS(text, voice).synthesize();
  return Buffer.from(await result.audio.arrayBuffer());
}

/**
 * @param {string} summary  summary text as shown to the user
 * @param {object} [deps]   { synthesize, toOgg } overrides, for tests
 * @returns {Promise<Buffer>} OGG/Opus audio ready for sendVoice
 */
async function synthesizeSpeech(summary, { synthesize = edgeSynthesize, toOgg = convertToOggOpus } = {}) {
  const text = prepareForSpeech(summary);
  if (!text) throw new Error("Nothing to speak");
  if (text.length > MAX_SPEECH_CHARS) throw new Error(`Text too long for speech (${text.length} chars)`);

  const mp3 = await withTimeout(synthesize(text, config.TTS_VOICE), SYNTHESIS_TIMEOUT_MS, "Speech synthesis");
  if (!mp3 || mp3.length < 200) throw new Error("Speech synthesis returned no audio");
  return toOgg(mp3);
}

module.exports = { synthesizeSpeech, prepareForSpeech, MAX_SPEECH_CHARS };

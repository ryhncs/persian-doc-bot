// Categorized vocabulary for Whisper prompt-biasing: English words and
// proper nouns commonly code-switched into Persian speech that Whisper
// tends to phonetically mistranscribe into Persian script instead of
// leaving in Latin script. Add new words to the relevant category as you
// spot mistranscriptions in real usage — buildWhisperPrompt() below
// rebuilds the natural-language prompt automatically, no other code needs
// to change.
const VOCABULARY = {
  techDev: [
    "live", "deploy", "update", "bug", "code", "server", "API", "bot",
    "database", "backend", "frontend", "push", "commit", "branch", "merge",
    "test", "config", "token", "key", "error", "log", "restart", "build",
    "docker", "webhook",
  ],
  loanwords: [
    "okay", "check", "link", "file", "chat", "group", "channel", "online",
    "offline", "download", "upload", "screenshot", "message", "call",
    "meeting", "email",
  ],
  platforms: [
    "Telegram", "WhatsApp", "Instagram", "Google", "GitHub", "Render",
    "Fly.io", "Groq", "Railway",
  ],
};

// One natural, code-switched Persian sentence per category, weaving in that
// category's words in Latin script — Whisper's `prompt` param biases far
// better toward a natural phrase than a raw word list, since it primes the
// model's expectation for *how* code-switching sounds, not just which words
// exist. Keep sentences here in sync with VOCABULARY when adding words.
const SENTENCES = {
  techDev:
    "برای اینکه بات live بشه، اول تو frontend و backend کد code رو زدیم، " +
    "بعد commit و push کردیم روی یه branch جدید و merge کردیم، test گرفتیم، " +
    "config و token و API key رو تنظیم کردیم، database رو update کردیم، " +
    "اگه bug و error تو log بود بررسی کردیم، build گرفتیم، docker رو ست " +
    "کردیم، webhook رو وصل کردیم، server رو restart کردیم و در آخر deploy کردیم.",
  loanwords:
    "okay، من link رو تو یه chat group فرستادم و بعد تو channel هم گذاشتم، " +
    "یه file و screenshot upload کردم، باید download هم بکنم، message رو " +
    "check کردم، online بودم ولی الان offline شدم، یه call و meeting داشتیم " +
    "و email رو هم فرستادم.",
  platforms:
    "من تو Telegram و WhatsApp و Instagram پیام دادم، کد رو تو GitHub " +
    "گذاشتم و با Render و Railway و Fly.io دیپلویش کردم، برای ترنسکریپشن " +
    "هم از Groq استفاده کردم.",
};

// Groq hard-rejects the Whisper `prompt` param over 896 bytes (its error
// message says "characters" but the limit is actually measured in UTF-8
// bytes — Persian text is multi-byte, so JS string .length under-counts
// it: a 738-char prompt here was reported by Groq as 1056 "characters",
// which is exactly its UTF-8 byte length). Stay well under that.
const MAX_PROMPT_BYTES = 850;

// Categories are included whole, greedily, in this priority order — most
// likely to appear in this bot's actual usage first — until the next one
// wouldn't fit. Reorder or add to this list; buildWhisperPrompt() re-fits
// automatically. Whisper only honors roughly the last ~224 tokens of a
// prompt anyway, so a shorter, higher-signal prompt loses little.
const CATEGORY_PRIORITY = ["techDev", "platforms", "loanwords"];

/**
 * Hard-truncates a string to at most maxBytes when UTF-8 encoded, without
 * splitting a multi-byte character. Safety net only — normal operation
 * should never reach this, since buildWhisperPrompt() fits whole category
 * sentences under the budget first.
 */
function truncateToByteLength(str, maxBytes) {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  return Buffer.from(str, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    // toString() renders any dangling partial multi-byte sequence at the
    // cut point as U+FFFD — strip it so the prompt doesn't end mid-glyph.
    .replace(/�+$/, "");
}

/**
 * Builds the natural-language prompt string sent to Whisper's `prompt`
 * param: whole category sentences, in priority order, greedily included
 * while they still fit under MAX_PROMPT_BYTES — lower-priority categories
 * (loanwords) are dropped first if the vocabulary grows too large to fit.
 * A final byte-truncation is applied as a safety net so this can never
 * silently exceed Groq's limit again, even if a single category sentence
 * later grows past the whole budget on its own.
 */
function buildWhisperPrompt() {
  let result = "";
  for (const category of CATEGORY_PRIORITY) {
    const sentence = SENTENCES[category];
    if (!sentence) continue;
    const candidate = result ? `${result} ${sentence}` : sentence;
    if (Buffer.byteLength(candidate, "utf8") <= MAX_PROMPT_BYTES) {
      result = candidate;
    }
  }
  return truncateToByteLength(result, MAX_PROMPT_BYTES);
}

module.exports = {
  VOCABULARY,
  SENTENCES,
  CATEGORY_PRIORITY,
  MAX_PROMPT_BYTES,
  buildWhisperPrompt,
};

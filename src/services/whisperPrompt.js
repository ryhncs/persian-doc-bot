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

/**
 * Builds the natural-language prompt string sent to Whisper's `prompt`
 * param. Note Whisper only honors roughly the last ~224 tokens of a prompt,
 * so keep SENTENCES compact rather than appending indefinitely — split off
 * a separate prompt-selection strategy (e.g. rotate categories) if this
 * grows much further.
 */
function buildWhisperPrompt() {
  return Object.values(SENTENCES).join(" ");
}

module.exports = { VOCABULARY, SENTENCES, buildWhisperPrompt };

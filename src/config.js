// Loads a local .env file if present (no-op in production if there isn't one).
require("dotenv").config();

// Falls back to the legacy BOT_TOKEN name so the currently-deployed bot
// keeps working without an env var rename.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// If WEBHOOK_URL is set (e.g. deploying to Runflare/Liara), the bot runs in
// webhook mode; otherwise it falls back to polling. Falls back to Render's
// auto-injected RENDER_EXTERNAL_URL so a Render web service needs zero
// manual URL configuration.
const WEBHOOK_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || "";
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Optional override for the long-poll timeout (seconds). Only useful behind
// a proxy/tunnel with a short idle timeout that can't hold a normal ~10s
// long-poll connection open; leave unset to use node-telegram-bot-api's
// default.
const POLLING_TIMEOUT_SECONDS = process.env.POLLING_TIMEOUT_SECONDS
  ? parseInt(process.env.POLLING_TIMEOUT_SECONDS, 10)
  : undefined;

// Full model, not turbo: turbo trades accuracy for speed, and we're
// nowhere near Groq's free-tier rate limits, so the accuracy is worth it.
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-large-v3";
// llama-3.3-70b-versatile (the originally planned model) has been removed
// from Groq's catalog as of this writing; openai/gpt-oss-120b verified
// working with good Persian output during local end-to-end testing.
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "openai/gpt-oss-120b";

const MAX_VOICE_DURATION_SECONDS =
  parseInt(process.env.MAX_VOICE_DURATION_SECONDS, 10) || 600; // 10 minutes

// Whisper is unreliable on very short clips regardless of prompt/language/
// temperature tuning (confirmed via testing: ~2s clips produced garbled
// output with no prompt sent at all). Below this, skip the Groq call
// entirely and ask the user to send a longer message.
const MIN_VOICE_DURATION_SECONDS =
  parseInt(process.env.MIN_VOICE_DURATION_SECONDS, 10) || 4;

const DAILY_VOICE_LIMIT_PER_USER =
  parseInt(process.env.DAILY_VOICE_LIMIT_PER_USER, 10) || 20;

// Kept a little under Groq's published free-tier caps (20/min Whisper,
// 30/min Llama) so we back off before Groq starts returning 429s.
const GLOBAL_WHISPER_PER_MINUTE = 18;
const GLOBAL_LLM_PER_MINUTE = 28;

module.exports = {
  TELEGRAM_BOT_TOKEN,
  GROQ_API_KEY,
  WEBHOOK_URL,
  PORT,
  POLLING_TIMEOUT_SECONDS,
  WHISPER_MODEL,
  SUMMARY_MODEL,
  MAX_VOICE_DURATION_SECONDS,
  MIN_VOICE_DURATION_SECONDS,
  DAILY_VOICE_LIMIT_PER_USER,
  GLOBAL_WHISPER_PER_MINUTE,
  GLOBAL_LLM_PER_MINUTE,
};

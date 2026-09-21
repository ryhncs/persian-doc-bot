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

// Ghostscript's built-in quality presets, roughly smallest-to-largest:
// /screen, /ebook, /printer, /prepress. /ebook is a good default — close to
// screen quality at a fraction of the size, fine for documents shared over
// chat.
const PDF_COMPRESS_PRESET = process.env.PDF_COMPRESS_PRESET || "/ebook";

// Kept a little under Groq's published free-tier caps (20/min Whisper,
// 30/min Llama) so we back off before Groq starts returning 429s.
const GLOBAL_WHISPER_PER_MINUTE = 18;
const GLOBAL_LLM_PER_MINUTE = 28;

// Groq's free tier caps tokens per minute (TPM) per model, and a single request
// larger than that is rejected outright (413). The context window (128K) is
// not the constraint; the per-minute budget is. Measured on this account:
// openai/gpt-oss-120b rejected a 15,792-char document that needed 8,380
// tokens against an 8,000 TPM cap. The PDF summarizer therefore splits long
// documents into chunks that each fit well inside the budget, summarizes them
// one at a time paced to stay under this many tokens per minute (see
// services/longSummarize.js), then combines the partial summaries.
const GROQ_TPM_LIMIT = parseInt(process.env.GROQ_TPM_LIMIT, 10) || 6000;

// Conservative characters-per-token estimate for mixed Persian/English text
// (measured ~1.88 on English-heavy technical text; Persian tokenizes worse).
const CHARS_PER_TOKEN_ESTIMATE = 1.6;

// Upper bound on the text of one PDF to summarize. Nothing under this is
// truncated, but the time is bounded by the TPM budget: roughly one minute per
// ~5,000 characters (60,000 chars is around 10 to 12 minutes), and the whole
// bot shares Groq's daily token allowance. Longer documents get a friendly
// "send it in parts" reply.
const MAX_DOCUMENT_CHARS_FOR_SUMMARY =
  parseInt(process.env.MAX_DOCUMENT_CHARS_FOR_SUMMARY, 10) || 40000;

// --- Monetization: weekly free-tier limit + manual card-to-card subscription.
// Per-user state lives in Supabase (see supabase/schema.sql). Enforcement is
// only switched on when ALL five required vars below are set; if some but not
// all are set the bot logs which are missing and stays unlimited, rather than
// locking users behind a paywall that has no card number on it.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const SUBSCRIPTION_PRICE_TOMAN = process.env.SUBSCRIPTION_PRICE_TOMAN || "";
const CARD_NUMBER = process.env.CARD_NUMBER || "";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
// Optional: shown to users whose payment was rejected (e.g. "@your_username").
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || "";

const freeRequestsEnv = parseInt(process.env.FREE_REQUESTS_PER_WEEK, 10);
const FREE_REQUESTS_PER_WEEK =
  Number.isInteger(freeRequestsEnv) && freeRequestsEnv >= 0 ? freeRequestsEnv : 3;
const SUBSCRIPTION_DAYS = 30;
// A user who was shown the paywall can send a receipt photo for this long;
// after that, photos go back to being treated as "compress this image".
const PENDING_PAYMENT_TTL_HOURS = 24;

// --- Referrals: an invitee's first delivered billable request gives both sides
// bonus requests (on top of the weekly allowance); every N successful referrals
// earns the referrer a discount coupon. Tracked in Supabase (fails open).
const intEnv = (name, fallback, min = 0) => {
  const n = parseInt(process.env[name], 10);
  return Number.isInteger(n) && n >= min ? n : fallback;
};
const REFERRAL_BONUS_REQUESTS = intEnv("REFERRAL_BONUS_REQUESTS", 2);
// Only a user's first N successful referrals earn them the bonus (limits
// farming with fake accounts); coupons keep counting past it.
const REFERRAL_BONUS_CAP = intEnv("REFERRAL_BONUS_CAP", 10);
const REFERRALS_PER_COUPON = intEnv("REFERRALS_PER_COUPON", 3, 1);
const COUPON_DISCOUNT_PERCENT = Math.min(intEnv("COUPON_DISCOUNT_PERCENT", 20), 100);
// Used for invite links until Telegram's getMe answers with the real username.
const BOT_USERNAME = (process.env.BOT_USERNAME || "koolehbot").replace(/^@/, "");

// --- Audio version of a summary (text to speech). Uses the free, unofficial
// Microsoft Edge read-aloud endpoint (no key, no cost). Set TTS_ENABLED=false to
// hide the button. Users who aren't paying from the weekly quota (subscribers,
// or everyone while the database is down) get a daily cap so cost and load stay
// bounded.
const TTS_ENABLED = !/^(false|0|no|off)$/i.test((process.env.TTS_ENABLED || "").trim());
const TTS_VOICE = process.env.TTS_VOICE || "fa-IR-DilaraNeural";
const SUBSCRIBER_AUDIO_PER_DAY = intEnv("SUBSCRIBER_AUDIO_PER_DAY", 15, 1);
// "🔊 تبدیل متن به صدا": longest text accepted, in characters. Measured with the
// Edge fa-IR voice: about 12 characters per second for casual Persian with
// digits (13.6 for plain prose), so 6 minutes (360 s) is roughly 4,300 to 4,900
// characters. 4,000 keeps the audio under 6 minutes even at the slow rate
// (about 5.5 minutes) and is just under Telegram's own 4,096-character limit
// for a single message.
const TTS_TEXT_MAX_CHARS = intEnv("TTS_TEXT_MAX_CHARS", 4000, 100);

const MISSING_MONETIZATION_VARS = Object.entries({
  SUPABASE_URL,
  SUPABASE_KEY,
  SUBSCRIPTION_PRICE_TOMAN,
  CARD_NUMBER,
  ADMIN_CHAT_ID,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);
const MONETIZATION_ENABLED = MISSING_MONETIZATION_VARS.length === 0;

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
  PDF_COMPRESS_PRESET,
  GLOBAL_WHISPER_PER_MINUTE,
  GLOBAL_LLM_PER_MINUTE,
  MAX_DOCUMENT_CHARS_FOR_SUMMARY,
  GROQ_TPM_LIMIT,
  CHARS_PER_TOKEN_ESTIMATE,
  SUPABASE_URL,
  SUPABASE_KEY,
  SUBSCRIPTION_PRICE_TOMAN,
  CARD_NUMBER,
  ADMIN_CHAT_ID,
  ADMIN_CONTACT,
  FREE_REQUESTS_PER_WEEK,
  SUBSCRIPTION_DAYS,
  PENDING_PAYMENT_TTL_HOURS,
  REFERRAL_BONUS_REQUESTS,
  REFERRAL_BONUS_CAP,
  REFERRALS_PER_COUPON,
  COUPON_DISCOUNT_PERCENT,
  BOT_USERNAME,
  TTS_ENABLED,
  TTS_VOICE,
  SUBSCRIBER_AUDIO_PER_DAY,
  TTS_TEXT_MAX_CHARS,
  MISSING_MONETIZATION_VARS,
  MONETIZATION_ENABLED,
};

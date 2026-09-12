# VoiceSum Bot

A Telegram bot with two features:

1. **Persian doc formatting** (original) — send any messy pasted text, get
   back a clean, RTL, properly fonted `.docx` file.
2. **VoiceSum** (new) — send or forward a voice message, get back a Persian
   summary in chat, with buttons to see the full transcript or export the
   summary/transcript as a `.docx`.

Both features share the same `docx` generation pipeline
(`rightToLeft: true`, Vazirmatn for Persian / Poppins for Latin text).

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram → get a token.
2. Get a Groq API key at [console.groq.com](https://console.groq.com) (needed for VoiceSum only — text formatting works without it).
3. Copy `.env.example` to `.env` and fill in the values (see [Environment variables](#environment-variables)).
4. Install dependencies:
   ```bash
   npm install
   ```
5. Run it:
   ```bash
   npm start
   ```
6. Open your bot in Telegram, send `/start`, then send text (→ docx) or a voice message (→ summary).

## Environment variables

| Variable                      | Required | Default                   | Notes                                                                 |
| ------------------------------ | -------- | -------------------------- | ---------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`           | yes      | —                           | Falls back to the legacy `BOT_TOKEN` name if that's already set.       |
| `GROQ_API_KEY`                 | for VoiceSum | —                       | Text-formatting flow still works without it; voice replies with a friendly Persian error if unset. |
| `WEBHOOK_URL`                  | no       | unset (polling mode)       | Public HTTPS base URL. Set this on Runflare/Liara to switch to webhook mode. Leave unset for polling (default, works everywhere, including the existing Railway deploy). |
| `PORT`                         | no       | `3000`                     | Only used in webhook mode.                                             |
| `WHISPER_MODEL`                | no       | `whisper-large-v3`         | Or `whisper-large-v3-turbo` for lower accuracy / faster.               |
| `SUMMARY_MODEL`                | no       | `openai/gpt-oss-120b`      | Verified working with good Persian output; see [Swapping the summarization model](#swapping-the-summarization-model). |
| `MAX_VOICE_DURATION_SECONDS`   | no       | `600` (10 min)             | Voice messages longer than this are rejected with a Persian message.   |
| `MIN_VOICE_DURATION_SECONDS`   | no       | `4`                        | Voice messages shorter than this are rejected with a Persian message — Whisper is unreliable on very short clips regardless of prompt/language/temperature tuning. |
| `DAILY_VOICE_LIMIT_PER_USER`   | no       | `20`                       | Per-user daily cap on voice messages processed (in-memory, resets at UTC midnight). |

## Core VoiceSum flow

1. User sends/forwards a voice message in a private chat.
2. Bot shows "⏳ در حال پردازش پیام صوتی..." immediately.
3. Bot downloads the audio via the Telegram Bot API.
4. Bot transcribes it with Groq's Whisper endpoint (raw OGG/OPUS first; if
   Groq rejects the format, it transcodes to 16kHz mono WAV with
   `ffmpeg-static` and retries once — see `src/services/transcribe.js`).
5. Bot summarizes the transcript in Persian via a Groq Llama model
   (`src/services/summarize.js`), preserving names/numbers/dates and staying
   in Persian even for mixed Persian/English speech.
6. Bot replies with the summary plus two buttons:
   - **متن کامل** — sends the full transcript as (possibly several,
     4096-char-chunked) text messages.
   - **خروجی Word** — asks whether to export the summary or the full
     transcript, then generates and sends a `.docx` via the same
     `docGenerator.js` module the text-formatting flow uses.

## Project structure

```
src/
  bot.js                 Entry point — wires up all handlers, polling/webhook setup
  config.js               Env vars + defaults in one place
  docGenerator.js          Text → RTL Persian .docx (shared by both features)
  handlers/
    voice.js               Voice/audio message → transcript → summary → reply
    callbacks.js            "متن کامل" / "خروجی Word" button handling
  services/
    groqClient.js            Low-level Groq REST wrapper (auth, error normalization)
    transcribe.js             Whisper transcription (+ ffmpeg fallback)
    summarize.js               Persian summarization prompt (swap LLM provider here)
    audioConvert.js             OGG → 16kHz mono WAV via ffmpeg-static
    telegramFile.js               Downloads a Telegram file by file_id
    sessionStore.js                 In-memory transcript/summary store for button callbacks
    rateLimiter.js                   Per-user daily + global per-minute limits
  utils/
    textChunk.js                     Splits long text into Telegram-safe message chunks
```

## Swapping the summarization model

Groq's Llama models can produce lower-quality Persian summaries than e.g.
GPT-4o-mini. `src/services/summarize.js` is the *only* file that knows which
provider generates the summary — swap it to call a different API and nothing
else in the bot needs to change.

## Rate limits (Groq free tier)

Groq's free tier caps roughly: ~2,000 Whisper requests/day, 7,200
audio-seconds/hour, 20 req/min on Whisper; ~30 req/min and ~100,000
tokens/day on Llama. `src/services/rateLimiter.js` implements:

- a per-user daily counter (`DAILY_VOICE_LIMIT_PER_USER`), and
- a global per-minute counter, kept a bit under Groq's caps.

Both are in-memory Maps — fine for a single-instance MVP. The file has a
comment showing the Redis key scheme to use once this needs to survive
restarts or run across multiple instances.

## Paid-tier hook (future)

Nothing currently gates `.docx` exports. To add a "paid users skip limits"
check later: `src/handlers/voice.js` and `src/handlers/callbacks.js` are the
only places that call into `rateLimiter.js` — add a user-lookup + bypass
there without touching the Groq or docx service modules.

## Local run

```bash
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN and GROQ_API_KEY
npm install
npm start
```

Leave `WEBHOOK_URL` unset for local dev — the bot uses polling.

## Deployment

### Railway (existing deploy — polling, no changes needed)

`railway.json` is already set up (`npm start`, Nixpacks build). Just make
sure `TELEGRAM_BOT_TOKEN` (or the legacy `BOT_TOKEN`) and `GROQ_API_KEY` are
set in the Railway project's environment variables. Leave `WEBHOOK_URL`
unset — Railway is a persistent process, so polling works fine as-is.

### Runflare / Liara (Docker, webhook mode)

The included `Dockerfile` builds the bot and runs it with an explicit
`CMD ["node", "src/bot.js"]` (no reliance on default entrypoint behavior).

1. Set environment variables on the platform:
   - `TELEGRAM_BOT_TOKEN`
   - `GROQ_API_KEY`
   - `WEBHOOK_URL` — the public HTTPS URL the platform assigns your service
     (no trailing slash), e.g. `https://your-app.runflare.app`
   - `PORT` — set to whatever port the platform expects your container to
     listen on (Runflare/Liara usually inject this automatically; make sure
     it matches what the container is told to expose)
2. Deploy the Dockerfile. On boot, the bot calls Telegram's `setWebHook` with
   `${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}` and starts an HTTP server on
   `PORT` to receive updates — no polling loop, no long-lived connection to
   Telegram needed.

### Render (Docker, webhook mode, free tier)

A separate, isolated deploy — not the production Railway service. Render's
free plan only supports **Web Services** (Background Workers require a paid
plan), so this runs in webhook mode. `render.yaml` is set up as a Blueprint
so this needs no manual URL configuration:

1. In the Render dashboard: **New > Blueprint**, connect this GitHub repo,
   and pick the `claude/voicesum-telegram-bot-138b43` branch (or whichever
   branch you're deploying). Render reads `render.yaml` and creates a Web
   Service named `voicesum-staging` from the existing `Dockerfile`.
2. When prompted for the two secret env vars, fill in:
   - `TELEGRAM_BOT_TOKEN`
   - `GROQ_API_KEY`
3. Deploy. `PORT` and `RENDER_EXTERNAL_URL` are auto-injected by Render;
   `src/config.js` falls back to `RENDER_EXTERNAL_URL` for `WEBHOOK_URL` when
   it isn't set explicitly, so the webhook URL is configured automatically —
   no second deploy needed.
4. Free-tier web services spin down after 15 minutes of no inbound HTTP
   traffic and take ~1 minute to wake back up on the next Telegram update.

## Notes / known limitations

- **Font rendering:** Vazirmatn needs to be installed on whoever opens the
  `.docx` for it to look right; if missing, Word/LibreOffice silently
  substitutes a fallback font.
- **Rate limiting is in-memory and per-instance.** Fine for one container;
  won't coordinate across multiple instances or survive restarts without the
  Redis upgrade noted in `rateLimiter.js`.
- **Session store is in-memory.** The "متن کامل" / "خروجی Word" buttons stop
  working ~6 hours after a summary was sent, or immediately after a restart
  — the user just needs to resend the voice message.
- **Tests:** none yet (nice-to-have, not required for the MVP per the
  original spec).

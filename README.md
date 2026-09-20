# کوله (Kooleh) — @koolehbot

Kooleh ("backpack") is a friendly Persian-language student-assistant Telegram
bot. All user-facing text is Persian, and it copes with mixed Persian/English
input.

1. **Word export** — send any messy pasted text, get back a clean, RTL,
   properly fonted `.docx` file. Always free.
2. **Voice summary** — send or forward a voice message, get back a Persian
   summary in chat, with buttons to see the full transcript or export the
   summary/transcript as a `.docx`.
3. **PDF summarization** — send a PDF and choose "خلاصه‌سازی": the bot
   extracts its text and returns a structured Persian summary (key points as
   bullet lines), with the same "متن کامل" / "خروجی Word" buttons as the
   voice flow.
4. **Translate & simplify** — every text message converted to a `.docx`
   (feature 1) also gets two buttons: "🌐 ترجمه و ساده‌سازی (فارسی)"
   translates non-Persian text to fluent Persian, then rewrites it
   (translated or already-Persian) in simpler language; "🔁 ترجمه به
   انگلیسی" translates the text (typically Persian) into plain English with
   no simplification step. Both reuse the same "متن اصلی" / "خروجی Word"
   buttons as the other summary-style flows.
5. **File compression** — send a photo, or a PDF and choose "کم کردن حجم",
   and get it back at a fraction of the size. Images are re-encoded with
   `sharp`; PDFs are compressed with Ghostscript (downsamples embedded
   images, subsets fonts, leaves text/vector content untouched). Always
   free.

Features 2–4 (the ones that call an LLM) are limited to a free weekly quota;
a manual card-to-card monthly subscription lifts the limit — see
[Free tier & subscriptions](#free-tier--subscriptions).

The Word export and the summary features share the same `docx` generation
pipeline (`rightToLeft: true`, Vazirmatn for Persian / Poppins for Latin
text).

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram → get a token.
2. Get a Groq API key at [console.groq.com](https://console.groq.com) (needed for the summary/translate features — Word export and compression work without it).
3. Make sure Ghostscript (`gs`) is on `PATH` — needed for PDF compression only; image compression and everything else works without it. The Dockerfile in this repo already installs it for Render (and Runflare/Liara, if you deploy there); for local dev, install it with your OS package manager (e.g. `apt install ghostscript`, `brew install ghostscript`).
4. Copy `.env.example` to `.env` and fill in the values (see [Environment variables](#environment-variables)).
5. Install dependencies:
   ```bash
   npm install
   ```
6. Run it:
   ```bash
   npm start
   ```
7. Open your bot in Telegram, send `/start`, then send text (→ docx), a voice message (→ summary), or a photo/PDF (→ compressed file).

## Environment variables

| Variable                      | Required | Default                   | Notes                                                                 |
| ------------------------------ | -------- | -------------------------- | ---------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`           | yes      | —                           | Falls back to the legacy `BOT_TOKEN` name if that's already set.       |
| `GROQ_API_KEY`                 | for the AI features | —                | Word export and compression still work without it; the AI features reply with a friendly Persian error if unset. |
| `WEBHOOK_URL`                  | no       | unset (polling mode)       | Public HTTPS base URL. Set this on Runflare/Liara to switch to webhook mode; on Render this is set automatically via `RENDER_EXTERNAL_URL` (see Deployment). Leave unset for polling (default, used for local dev). |
| `PORT`                         | no       | `3000`                     | Only used in webhook mode.                                             |
| `WHISPER_MODEL`                | no       | `whisper-large-v3`         | Or `whisper-large-v3-turbo` for lower accuracy / faster.               |
| `SUMMARY_MODEL`                | no       | `openai/gpt-oss-120b`      | Verified working with good Persian output; see [Swapping the summarization model](#swapping-the-summarization-model). |
| `MAX_VOICE_DURATION_SECONDS`   | no       | `600` (10 min)             | Voice messages longer than this are rejected with a Persian message.   |
| `MIN_VOICE_DURATION_SECONDS`   | no       | `4`                        | Voice messages shorter than this are rejected with a Persian message — Whisper is unreliable on very short clips regardless of prompt/language/temperature tuning. |
| `DAILY_VOICE_LIMIT_PER_USER`   | no       | `20`                       | Per-user daily cap on voice messages processed (in-memory, resets at UTC midnight). |
| `PDF_COMPRESS_PRESET`          | no       | `/ebook`                  | Ghostscript `PDFSETTINGS` preset for PDF compression. Other options: `/screen` (smallest, lowest quality), `/printer`, `/prepress` (largest, closest to original). |
| `MAX_DOCUMENT_CHARS_FOR_SUMMARY` | no     | `8000`                    | Character-count cap on extracted PDF text before summarization is attempted — sized to stay under Groq's measured per-minute token cap for `SUMMARY_MODEL` on this account (see `config.js`). Longer documents get a friendly "too long, send a shorter excerpt" reply instead of a failed summary. |
| `SUPABASE_URL`                 | for limits | —                     | Supabase project URL. See [Free tier & subscriptions](#free-tier--subscriptions). |
| `SUPABASE_KEY`                 | for limits | —                     | Supabase **service_role** key (server-side only — never expose it). |
| `SUBSCRIPTION_PRICE_TOMAN`     | for limits | —                     | Monthly price shown on the paywall, digits only (e.g. `150000`). |
| `CARD_NUMBER`                  | for limits | —                     | Card number users transfer to, shown on the paywall. |
| `ADMIN_CHAT_ID`                | for limits | —                     | Telegram user id (or group chat id) that receives payment receipts with ✅/❌ buttons. The admin must press Start on the bot once. |
| `ADMIN_CONTACT`                | no       | unset                      | Shown to users whose payment was rejected, e.g. `@your_username`. |
| `FREE_REQUESTS_PER_WEEK`       | no       | `3`                        | Free AI-feature requests per user per rolling 7 days. |

"for limits" = enforcement only switches on when **all five** of
`SUPABASE_URL`, `SUPABASE_KEY`, `SUBSCRIPTION_PRICE_TOMAN`, `CARD_NUMBER` and
`ADMIN_CHAT_ID` are set. If none are set the bot runs with every feature
unlimited (handy for local dev); if only some are set it logs which are
missing at startup and stays unlimited, rather than showing a paywall with no
card number on it.

## Voice summary flow

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
  docGenerator.js          Text → RTL Persian .docx (shared by the Word export and summary features)
  messages.js              /start and /help copy
  handlers/
    voice.js               Voice/audio message → transcript → summary → reply
    callbacks.js            "متن کامل" / "خروجی Word" (+ PDF-choice, + translate) button handling
    compress.js              Photo/document message → compressed file → reply
    payment.js                Paywall, receipt-photo forwarding to the admin, ✅/❌ approval buttons
  services/
    groqClient.js            Low-level Groq REST wrapper (auth, error normalization)
    transcribe.js             Whisper transcription (+ ffmpeg fallback)
    summarize.js               Persian summarization prompts (voice + document; swap LLM provider here)
    translateSimplify.js        Translate-to-Persian+simplify AND Persian-to-English prompts (same Groq model)
    audioConvert.js             OGG → 16kHz mono WAV via ffmpeg-static
    telegramFile.js               Downloads a Telegram file by file_id
    sessionStore.js                 In-memory transcript/summary store for button callbacks
    rateLimiter.js                   Per-user daily + global per-minute limits
    imageCompress.js                 Image → smaller JPEG via sharp
    pdfCompress.js                    PDF → smaller PDF via Ghostscript (`gs` binary)
    pdfText.js                        PDF → extracted plain text via pdf-parse (no native binary)
    usage.js                           Free weekly quota + subscription policy (fails open)
    supabaseStore.js                    Supabase (PostgREST) client for the `users` table, plain fetch
  utils/
    textChunk.js                     Splits long text into Telegram-safe message chunks
    format.js                        Persian numbers/dates, HTML escaping
supabase/
  schema.sql                        `users` table — run once in the Supabase SQL editor
test/                               `npm test` (node:test): quota policy, Supabase requests, payment flow
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

## Free tier & subscriptions

**What counts.** Voice summary, PDF summary and translate/simplify (both
buttons) share one quota: **3 requests per user per rolling 7 days**
(`FREE_REQUESTS_PER_WEEK`). Text→Word export and image/PDF compression never
count and are never blocked.

**How the window works.** A user's window starts at their first counted
request; `week_reset_at` is when the counter next resets. A request that
fails (Groq error, "PDF has no text layer", "too long", rate limit…) is
refunded — only a delivered result costs a request. Subscribers
(`subscription_expires_at` in the future) are unlimited and never counted.

**The paywall.** When a free user is out of requests they get a message with
the monthly price (`SUBSCRIPTION_PRICE_TOMAN`), the card number
(`CARD_NUMBER`, tap-to-copy) and instructions to send a screenshot of the
transfer as a photo.

**Receipts and approval.** Showing the paywall sets `payment_pending_at`. For
the next 24 hours a photo from that user is treated as a payment receipt
instead of "compress this image": it is sent to `ADMIN_CHAT_ID` with the
user's name/@username/id and two inline buttons.

- **✅ تایید** → `subscription_expires_at = now + 30 days`, the pending flag is
  cleared, and the user is told their subscription is active, with the
  (Jalali) expiry date.
- **❌ رد** → the user is told the payment couldn't be verified (with
  `ADMIN_CONTACT` if set) and to double-check and resend. They stay "pending",
  so a corrected receipt still reaches the admin.

Only the admin chat can press these buttons, and the buttons are removed once
pressed. Repeated photos from one user are throttled to one per 15 s so the
admin can't be spammed.

**If the database is down** the bot fails *open*: requests are allowed and not
counted (and logged), rather than locking everyone out. The Groq free-tier
rate limits still cap the cost.

### Setting it up

1. Create a project at [supabase.com](https://supabase.com), open **SQL Editor**
   and run [`supabase/schema.sql`](supabase/schema.sql). It creates the
   `users` table and turns on row-level security with no policies, so only the
   service key can touch it.
2. From **Project Settings → API** copy the project URL and the
   **service_role** key.
3. Set the five monetization env vars (see the table above) — on Render, in the
   service's **Environment** tab — and redeploy. The admin must press **Start**
   on the bot once so Telegram lets it message them.
4. Watch the startup log: `Monetization: enabled (3 free premium requests/week
   per user).` confirms everything is wired; a `Monetization is DISABLED —
   missing env vars: …` warning tells you what's left.

Run `npm test` for the automated tests (quota policy incl. concurrency,
Supabase request shapes, and the payment flow against a mock bot).

## Local run

```bash
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN and GROQ_API_KEY
npm install
npm start
```

Leave `WEBHOOK_URL` unset for local dev — the bot uses polling.

## Deployment

Render is the deploy target (both staging and production). See below.

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

Render's free plan only supports **Web Services** (Background Workers
require a paid plan), so this runs in webhook mode. `render.yaml` is set up
as a Blueprint so this needs no manual URL configuration:

1. In the Render dashboard: **New > Blueprint**, connect this GitHub repo,
   and pick the branch you're deploying (normally `master`). Render reads
   `render.yaml` and creates the Web Service it defines from the existing
   `Dockerfile`.
2. When prompted for the two secret env vars, fill in:
   - `TELEGRAM_BOT_TOKEN`
   - `GROQ_API_KEY`

   Then add the monetization variables in the service's **Environment** tab
   (see [Free tier & subscriptions](#free-tier--subscriptions)).
3. Deploy. `PORT` and `RENDER_EXTERNAL_URL` are auto-injected by Render;
   `src/config.js` falls back to `RENDER_EXTERNAL_URL` for `WEBHOOK_URL` when
   it isn't set explicitly, so the webhook URL is configured automatically —
   no second deploy needed.
4. Free-tier web services spin down after 15 minutes of no inbound HTTP
   traffic and take ~1 minute to wake back up on the next Telegram update.

## Translate & simplify

Every text message that gets converted to a `.docx` (feature 1) also gets a
follow-up message with two buttons, both hitting the same Groq model used
for summarization but with different prompts:

- **"🌐 ترجمه و ساده‌سازی (فارسی)"** — if the text isn't Persian, translates
  it first, then (translated or original) rewrites it in simpler
  language — shorter sentences, easier vocabulary, technical
  terms/numbers/names kept exact.
- **"🔁 ترجمه به انگلیسی"** — translates the text (typically Persian) into
  plain, fluent English with no simplification step — for writing an
  English abstract/email from Persian notes, for example.

Both results get the same "متن اصلی" / "خروجی Word" buttons as the
voice and PDF-summary flows (via the same session-store mechanism — see
`src/services/translateSimplify.js`'s `translateAndSimplify` /
`translateToEnglish`, and the `txt:translate` / `txt:toEnglish` handling in
`src/handlers/callbacks.js`).

No separate character-length guard is needed here: Telegram caps a single
text message at 4096 characters, which stays comfortably under this Groq
account's 8000 TPM budget even accounting for the prompt and a
translation+simplification-length reply.

## PDF: summarize or compress?

Since a PDF can go through either the compression or the summarization
flow, sending one doesn't act immediately — the bot asks first via two
inline buttons ("📝 خلاصه‌سازی" / "🗜 کم کردن حجم"). The choice, plus the
file's Telegram `file_id`, is kept in the same short-lived in-memory
session store the voice-summary buttons use; the PDF itself is only
re-downloaded once the user picks an action, so nothing large sits in
memory while they're deciding.

Summarization extracts text with `pdf-parse` (pure JS, separate from the
Ghostscript-based compression path) and summarizes it with the same Groq
model as the voice summary, but a different system prompt tuned for written
documents (lecture notes, slides, papers) rather than spoken transcripts —
see `src/services/summarize.js`. A PDF with no real text layer (a scan with
no OCR) gets a clear "can't extract text from this" reply rather than a
garbled or empty summary — full OCR (photographed handwriting/slides) is a
possible future addition, not implemented yet.

## File compression

- **Images**: any photo sent to the bot is downloaded at Telegram's largest
  available size, re-encoded as JPEG (`quality: 70`, capped at 1920px wide)
  with `sharp`, and sent back as a document — as a document rather than a
  photo, so Telegram doesn't re-compress it a second time. Typically cuts a
  phone photo to 20-40% of its original size with no visible quality loss.
- **PDFs**: sent as a Telegram "document" with `mime_type: application/pdf`.
  Compressed via Ghostscript's `/ebook` preset (downsamples embedded images,
  subsets fonts). Text and vectors are untouched, so a text-only PDF won't
  shrink much — the size win is mostly on PDFs with embedded images/scans.
  Requires the `gs` binary on the host (see [Setup](#setup)); if it's
  missing, the bot replies with a clear Persian error instead of crashing.
- Both replies include a caption with the before/after size and percentage
  saved.
- Non-PDF documents (e.g. a `.docx` or `.zip` sent as a file) get a
  friendly "not supported yet" reply rather than being silently ignored.
- 20MB cap on incoming files — a Telegram Bot API limit on file downloads,
  not something this bot can raise.

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

# Persian Doc Bot (MVP)

Telegram bot: send it messy pasted text, get back a clean, RTL, properly
fonted `.docx` file. Built on the same `docx` conventions as the
DoMyProject.ir pipeline (`rightToLeft: true`, Vazirmatn for Persian).

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram → get a token.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run it:
   ```bash
   BOT_TOKEN=your-token-here npm start
   ```
4. Open your bot in Telegram, send `/start`, then send any text.

## Files

- `src/docGenerator.js` — text → `.docx` buffer. Cleans up messy line
  breaks/spacing, splits into paragraphs, applies RTL + font per run.
- `src/bot.js` — Telegram polling bot. Any non-command text message gets
  converted and sent back as a document.

## Notes / next steps

- **Polling vs. webhook:** this MVP uses polling, which needs a
  long-running process (a small VPS, or a free tier on Railway/Render
  work well). For a serverless deploy (e.g. Netlify Functions) you'd
  switch to webhook mode — happy to do that once you've picked a host.
- **Font rendering:** Vazirmatn needs to be installed on whoever opens
  the file for it to look right; if it's missing, Word/LibreOffice
  silently substitutes a fallback. Worth mentioning in the bot's
  welcome message once you're past the MVP stage.
- **Mixed-language lines:** currently a whole paragraph gets one font
  (Persian if it contains any Persian characters, English otherwise).
  Good enough for the demo video; splitting fonts per word within a
  single line is a possible v2 improvement if you want tighter control.
- **Not yet handled:** very long messages (Telegram caps text messages
  at 4096 chars, so nothing over that reaches the bot), input
  validation, rate limiting.

const TelegramBot = require("node-telegram-bot-api");
const { textToDocxBuffer } = require("./docGenerator");
const { handleVoiceMessage } = require("./handlers/voice");
const { handleCallbackQuery } = require("./handlers/callbacks");
const { handlePhotoMessage, handleDocumentMessage } = require("./handlers/compress");
const { createSession } = require("./services/sessionStore");
const config = require("./config");

const TOKEN = config.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error(
    "Missing TELEGRAM_BOT_TOKEN (or legacy BOT_TOKEN) environment variable. Set it before starting the bot."
  );
  process.exit(1);
}

if (!config.GROQ_API_KEY) {
  console.warn(
    "GROQ_API_KEY is not set — voice transcription/summarization will reply with a friendly error until it is configured."
  );
}

// Webhook mode kicks in when WEBHOOK_URL is set (e.g. deploying to
// Runflare/Liara); otherwise this falls back to polling, which is how this
// bot has always run — so existing deployments keep working unchanged.
const useWebhook = Boolean(config.WEBHOOK_URL);

const bot = useWebhook
  ? new TelegramBot(TOKEN, { webHook: { port: config.PORT } })
  : new TelegramBot(TOKEN, {
      polling:
        config.POLLING_TIMEOUT_SECONDS !== undefined
          ? { params: { timeout: config.POLLING_TIMEOUT_SECONDS } }
          : true,
    });

if (useWebhook) {
  const webhookPath = `/bot${TOKEN}`;
  bot.setWebHook(`${config.WEBHOOK_URL}${webhookPath}`).catch((err) => {
    console.error("Failed to register Telegram webhook:", err.message);
  });
  console.log(`Bot is running (webhook mode) on port ${config.PORT}...`);
} else {
  console.log("Bot is running (polling mode)...");
}

const WELCOME = [
  "سلام! 👋",
  "",
  "هر متن شلوغی رو (کپی‌شده از واتساپ، وردپرس، هر جا) برام بفرست،",
  "یه فایل Word مرتب، راست‌به‌چپ و با فونت درست برات می‌سازم.",
  "",
  "یا یه پیام صوتی برام بفرست (یا فوروارد کن) تا متنش رو پیاده و خلاصه کنم.",
  "",
  "یه عکس بفرستی حجمش رو برات کم می‌کنم؛ یه فایل پی‌دی‌اف بفرستی می‌پرسم می‌خوای خلاصه‌ش کنم یا حجمش رو کم کنم.",
  "",
  "زیر هر متنی که برات Word می‌سازم دو تا دکمه‌ی ترجمه هم هست: یکی برای ترجمه و ساده‌سازی به فارسی، یکی برای ترجمه به انگلیسی.",
  "",
  "کافیه متن، صدا، عکس یا پی‌دی‌اف رو بفرستی — چیز دیگه‌ای لازم نیست.",
].join("\n");

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, WELCOME);
});

bot.on("message", async (msg) => {
  // Ignore commands (handled above) and non-text messages for the MVP.
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const rawText = msg.text;

  try {
    await bot.sendChatAction(chatId, "upload_document");

    const buffer = await textToDocxBuffer(rawText);

    await bot.sendDocument(
      chatId,
      buffer,
      {},
      {
        filename: "document.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }
    );

    // Student-assistant feature: offer to translate/simplify the same text.
    // Only the raw text is kept in the session (no result yet) — see
    // handlers/callbacks.js's "txt:translate" handling, which does the
    // actual Groq call once the button is pressed, not before.
    const sessionId = createSession({ userId, chatId, transcript: rawText });
    await bot.sendMessage(chatId, "می‌خوای این متن رو ترجمه هم بکنم؟", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🌐 ترجمه و ساده‌سازی (فارسی)", callback_data: `txt:translate:${sessionId}` },
            { text: "🔁 ترجمه به انگلیسی", callback_data: `txt:toEnglish:${sessionId}` },
          ],
        ],
      },
    });
  } catch (err) {
    console.error("Failed to generate/send document:", err);
    bot.sendMessage(chatId, "یه مشکلی پیش اومد، دوباره امتحان کن.");
  }
});

// New: voice-message transcription + summarization flow.
bot.on("voice", (msg) => {
  handleVoiceMessage(bot, msg).catch((err) => {
    console.error("Unhandled error in voice handler:", err);
  });
});

bot.on("audio", (msg) => {
  handleVoiceMessage(bot, msg).catch((err) => {
    console.error("Unhandled error in voice handler:", err);
  });
});

// New: image/PDF compression flow.
bot.on("photo", (msg) => {
  handlePhotoMessage(bot, msg).catch((err) => {
    console.error("Unhandled error in photo handler:", err);
  });
});

bot.on("document", (msg) => {
  handleDocumentMessage(bot, msg).catch((err) => {
    console.error("Unhandled error in document handler:", err);
  });
});

bot.on("callback_query", (callbackQuery) => {
  handleCallbackQuery(bot, callbackQuery).catch((err) => {
    console.error("Unhandled error in callback query handler:", err);
  });
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

bot.on("webhook_error", (err) => {
  console.error("Webhook error:", err.message);
});

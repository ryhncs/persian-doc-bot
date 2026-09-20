const TelegramBot = require("node-telegram-bot-api");
const { textToDocxBuffer } = require("./docGenerator");
const { handleVoiceMessage } = require("./handlers/voice");
const { handleCallbackQuery } = require("./handlers/callbacks");
const { handlePhotoMessage, handleDocumentMessage } = require("./handlers/compress");
const { createSession } = require("./services/sessionStore");
const { handlePaymentPhoto } = require("./handlers/payment");
const { welcomeMessage, helpMessage } = require("./messages");
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

if (config.MONETIZATION_ENABLED) {
  console.log(`Monetization: enabled (${config.FREE_REQUESTS_PER_WEEK} free premium requests/week per user).`);
} else if (config.MISSING_MONETIZATION_VARS.length < 5) {
  console.warn(
    `Monetization is DISABLED (all features unlimited) — missing env vars: ${config.MISSING_MONETIZATION_VARS.join(", ")}.`
  );
} else {
  console.log("Monetization: disabled (no Supabase/payment env vars set) — all features unlimited.");
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

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, welcomeMessage());
});

bot.onText(/^\/help(?:@\w+)?\s*$/, (msg) => {
  bot.sendMessage(msg.chat.id, helpMessage());
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
// A photo from a user who was just shown the paywall is a payment receipt
// (forwarded to the admin); any other photo is an image to compress.
bot.on("photo", async (msg) => {
  try {
    if (await handlePaymentPhoto(bot, msg)) return;
    await handlePhotoMessage(bot, msg);
  } catch (err) {
    console.error("Unhandled error in photo handler:", err);
  }
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

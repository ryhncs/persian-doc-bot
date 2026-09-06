const TelegramBot = require("node-telegram-bot-api");
const { textToDocxBuffer } = require("./docGenerator");

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("Missing BOT_TOKEN environment variable. Set it before starting the bot.");
  process.exit(1);
}

// Polling mode: simplest for local testing / a small always-on server.
// (Switch to webhook mode later if deploying to serverless — see README.)
const bot = new TelegramBot(TOKEN, { polling: true });

const WELCOME = [
  "سلام! 👋",
  "",
  "هر متن شلوغی رو (کپی‌شده از واتساپ، وردپرس، هر جا) برام بفرست،",
  "یه فایل Word مرتب، راست‌به‌چپ و با فونت درست برات می‌سازم.",
  "",
  "کافیه متن رو بفرستی — چیز دیگه‌ای لازم نیست.",
].join("\n");

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, WELCOME);
});

bot.on("message", async (msg) => {
  // Ignore commands (handled above) and non-text messages for the MVP.
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
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
  } catch (err) {
    console.error("Failed to generate/send document:", err);
    bot.sendMessage(chatId, "یه مشکلی پیش اومد، دوباره امتحان کن.");
  }
});

console.log("Bot is running (polling mode)...");

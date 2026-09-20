const config = require("../config");
const { createSession } = require("../services/sessionStore");
const { translateAndSimplify, translateToEnglish } = require("../services/translateSimplify");
const { GroqRateLimitError } = require("../services/groqClient");
const { checkGlobalMinuteRate } = require("../services/rateLimiter");
const { gatePremiumFeature, releasePremiumFeature } = require("./payment");

const RATE_LIMIT_MESSAGE = "الان درخواست‌ها زیاده، چند لحظه دیگه دوباره امتحان کن 🙏";
const NO_GROQ_KEY_MESSAGE = "قابلیت خلاصه‌سازی فعلاً روی این بات فعال نیست.";
const PROCESSING_TRANSLATE_SIMPLIFY = "⏳ در حال ترجمه و ساده‌سازی...";
const PROCESSING_TO_ENGLISH = "⏳ در حال ترجمه به انگلیسی...";
const TRANSLATE_ERROR = "ترجمه/ساده‌سازی این متن با مشکل مواجه شد. دوباره امتحان کن.";

/**
 * Translates/simplifies `text` for a user and replies with the result plus the
 * usual "متن اصلی"/"خروجی Word" buttons. Shared by the inline buttons under a
 * Word export (action "translate" = to simplified Persian, "toEnglish" = to
 * English) and by the "🌐 ترجمه و ساده‌سازی متن" menu button.
 *
 * Counts against the weekly free quota and refunds it unless a result was
 * actually delivered.
 */
async function runTranslation(bot, chatId, userId, text, action) {
  if (!config.GROQ_API_KEY) {
    await bot.sendMessage(chatId, NO_GROQ_KEY_MESSAGE);
    return;
  }

  if (!checkGlobalMinuteRate("llm", config.GLOBAL_LLM_PER_MINUTE)) {
    await bot.sendMessage(chatId, RATE_LIMIT_MESSAGE);
    return;
  }

  const gate = await gatePremiumFeature(bot, chatId, userId);
  if (!gate) return;

  await bot.sendMessage(chatId, action === "toEnglish" ? PROCESSING_TO_ENGLISH : PROCESSING_TRANSLATE_SIMPLIFY);

  let succeeded = false;
  try {
    const result =
      action === "toEnglish" ? await translateToEnglish(text) : await translateAndSimplify(text);

    const newSessionId = createSession({ userId, chatId, transcript: text, summary: result });

    await bot.sendMessage(chatId, result, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "متن اصلی", callback_data: `vs:full:${newSessionId}` },
            { text: "خروجی Word", callback_data: `vs:docx:${newSessionId}` },
          ],
        ],
      },
    });
    succeeded = true;
  } catch (err) {
    console.error("Translate/simplify failed:", {
      chatId,
      action,
      error: err && err.message,
      stack: err && err.stack,
    });
    const message = err instanceof GroqRateLimitError ? RATE_LIMIT_MESSAGE : TRANSLATE_ERROR;
    await bot.sendMessage(chatId, message);
  } finally {
    if (!succeeded) await releasePremiumFeature(userId, gate);
  }
}

module.exports = { runTranslation };

const config = require("../config");
const { groqFetch } = require("./groqClient");

// Same Groq model/provider as summarize.js, isolated in its own function so
// the provider or prompt can be swapped later without touching callers —
// same convention as summarizeTranscript / summarizeDocumentText.

const SYSTEM_PROMPT = `تو یک دستیار ترجمه و ساده‌سازی متن برای دانشجو هستی. متنی که کاربر می‌فرستد ممکن است انگلیسی، فارسی یا ترکیبی از هر دو باشد.

وظیفه‌ات:
- اگر متن اصلی به زبانی غیر از فارسی بود، ابتدا زیر عنوان «🔤 ترجمه» یک ترجمه‌ی روان، دقیق و کاملاً فارسیِ کل متن بنویس (نه ترجمه‌ی تحت‌اللفظی).
- سپس زیر عنوان «📝 نسخه‌ی ساده» همان مطلب را (چه ترجمه‌شده چه از ابتدا فارسی بوده) با جمله‌های کوتاه‌تر، واژه‌های ساده‌تر و بدون اصطلاحات پیچیده بازنویسی کن؛ مفهوم اصلی نباید از دست برود.
- اگر متن اصلی از ابتدا کاملاً فارسی بود، فقط بخش «📝 نسخه‌ی ساده» را بده و بخش «🔤 ترجمه» را ننویس.
- اعداد، اسامی خاص، فرمول‌ها و اصطلاحات تخصصی را دقیق حفظ کن؛ اگر یک اصطلاح تخصصی انگلیسی مهم است، معادل فارسی‌اش را بنویس و خود اصطلاح انگلیسی را داخل پرانتز نگه‌دار.
- مقدمه یا توضیح اضافه درباره‌ی کاری که انجام می‌دهی ننویس؛ مستقیم برو سر خروجی با همان دو عنوان بالا.
- نقطه‌گذاری فارسی را درست رعایت کن.`;

/**
 * Translates (if needed) and simplifies a short piece of text — the "one
 * hard paragraph" student-assistant use case, as opposed to summarize.js's
 * whole-document condensation. Input is expected to be Telegram-message
 * length (<=4096 chars), which stays comfortably under this Groq account's
 * 8000 TPM cap (see config.js's MAX_DOCUMENT_CHARS_FOR_SUMMARY comment for
 * the measured chars-per-token ratio), so no separate length guard here.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
async function translateAndSimplify(text) {
  console.log(`[translateSimplify] requesting translation/simplification for ${text.length}-char text...`);
  const result = await groqFetch("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.SUMMARY_MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  console.log("[translateSimplify] result received");
  return result.choices[0].message.content.trim();
}

// Separate system prompt for the reverse direction: Persian (or anything
// else) -> fluent English, no simplification step. Kept as its own function
// rather than a flag on translateAndSimplify because the output shape is
// different (one plain translation, not two labeled sections) and the two
// are triggered by separate buttons — see the "txt:toEnglish" callback in
// handlers/callbacks.js.
const TO_ENGLISH_SYSTEM_PROMPT = `You are a translation assistant for a student. The user will send text in Persian (or occasionally another language); translate it into fluent, natural academic/general English — not a literal word-for-word translation.

Rules:
- Preserve numbers, proper nouns, formulas, and technical terms exactly.
- If a term is a well-established English technical term that the Persian text rendered phonetically or descriptively, use the standard English term.
- Do not add an introduction or explanation of what you are doing — output only the translation.
- If the input is already in English, return it unchanged (do not add commentary).`;

/**
 * Translates arbitrary text (typically Persian) into English. The
 * counterpart to translateAndSimplify's non-Persian-to-Persian direction,
 * for the "🔁 ترجمه به انگلیسی" button.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
async function translateToEnglish(text) {
  console.log(`[translateSimplify] requesting English translation for ${text.length}-char text...`);
  const result = await groqFetch("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.SUMMARY_MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: TO_ENGLISH_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  console.log("[translateSimplify] English translation received");
  return result.choices[0].message.content.trim();
}

module.exports = { translateAndSimplify, translateToEnglish };

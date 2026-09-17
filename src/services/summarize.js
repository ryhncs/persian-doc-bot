const config = require("../config");
const { groqFetch } = require("./groqClient");

// Kept isolated in its own module/function (per project convention) so the
// LLM provider can be swapped (e.g. to GPT-4o-mini for better Persian
// quality) by editing only this file — nothing else in the bot depends on
// which provider produces the summary.

const SYSTEM_PROMPT = `تو یک دستیار خلاصه‌نویسی فارسی هستی. متنی که کاربر می‌فرستد رونوشت (ترنسکریپت) یک پیام صوتی است که ممکن است ترکیبی از فارسی و انگلیسی باشد (کد-سوییچینگ).

وظیفه‌ات:
- یک خلاصه‌ی طبیعی، روان و خوش‌نویس به زبان فارسی بنویس؛ این خلاصه نباید ترجمه‌ی تحت‌اللفظی باشد، بلکه باید مفهوم و نکات اصلی صحبت را در چند جمله یا چند بند کوتاه بیان کند.
- نام‌ها، اعداد، تاریخ‌ها و جزئیات مهم ذکرشده در متن را حتماً و دقیقاً در خلاصه حفظ کن.
- اگر بخشی از صحبت به انگلیسی بوده، مفهومش را هم به فارسی روان برگردان و در خلاصه بگنجان؛ خروجی نهایی باید کاملاً به زبان فارسی باشد.
- مقدمه یا توضیح اضافه درباره‌ی این‌که «این یک خلاصه است» ننویس؛ مستقیم برو سر اصل مطلب.
- نقطه‌گذاری فارسی را درست رعایت کن و جمله‌ها را کامل و روان بنویس.`;

async function summarizeTranscript(transcript) {
  console.log(`[summarize] requesting summary for ${transcript.length}-char transcript...`);
  const result = await groqFetch("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.SUMMARY_MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
    }),
  });

  console.log("[summarize] summary received");
  return result.choices[0].message.content.trim();
}

// Separate system prompt for the student-assistant document flow (PDF
// lecture notes / papers), as opposed to a spoken-voice transcript: this
// content is already written text, may be structured (headings, bullet
// points, numbered lists) and is often academic/technical, so the summary
// should preserve that structure rather than just condense spoken language.
const DOCUMENT_SYSTEM_PROMPT = `تو یک دستیار درسی فارسی هستی که برای دانشجوها خلاصه و نکات کلیدی از جزوه، اسلاید یا مقاله می‌سازی.

وظیفه‌ات:
- یک خلاصه‌ی ساختاریافته و مفید برای مرور درسی بنویس: ابتدا در ۲ تا ۳ جمله موضوع کلی سند را بگو، سپس نکات کلیدی را به‌صورت خط به خط (هر نکته یک خط، با یک خط تیره در ابتدای آن) فهرست کن.
- اصطلاحات تخصصی، فرمول‌ها، تعریف‌ها، نام افراد و اعداد مهم را دقیقاً همان‌طور که در متن آمده حفظ کن؛ اگر متن انگلیسی بود، اصطلاح تخصصی انگلیسی را داخل پرانتز جلوی معادل فارسی‌اش نگه‌دار.
- اگر سند به زبان انگلیسی است، خلاصه را به فارسی روان بنویس، نه ترجمه‌ی کلمه‌به‌کلمه.
- مقدمه یا توضیح اضافه درباره‌ی «این یک خلاصه است» ننویس؛ مستقیم برو سر اصل مطلب.
- نقطه‌گذاری فارسی را درست رعایت کن.`;

/**
 * Summarizes arbitrary document text (PDF lecture notes, slides, papers)
 * extracted via services/pdfText.js. Kept as a separate function/prompt from
 * summarizeTranscript because spoken-voice transcripts and written documents
 * need different summarization instructions, even though both go through
 * the same Groq model/provider.
 */
async function summarizeDocumentText(text) {
  console.log(`[summarize] requesting document summary for ${text.length}-char text...`);
  const result = await groqFetch("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.SUMMARY_MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: DOCUMENT_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  console.log("[summarize] document summary received");
  return result.choices[0].message.content.trim();
}

module.exports = { summarizeTranscript, summarizeDocumentText };

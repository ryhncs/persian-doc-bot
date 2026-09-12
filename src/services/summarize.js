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

module.exports = { summarizeTranscript };

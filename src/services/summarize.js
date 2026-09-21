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

// --- Long-document (map-reduce) prompts. A document too big for one request
// is split into chunks (services/textChunker.js); each chunk is summarized
// (map), then the partial summaries are merged level by level (combine) until
// one final structured summary remains (final). Orchestration and pacing under
// the Groq TPM cap live in services/longSummarize.js; only the model calls
// and prompts live here.

const CHUNK_SYSTEM_PROMPT = `تو دستیار درسی هستی. کاربر یک بخش از یک سند درسی (جزوه، اسلاید یا مقاله) را می‌فرستد و این بخش یکی از چند بخش پشت‌سرهم است.
نکات کلیدی همین بخش را به فارسی روان و فشرده بنویس: هر نکته یک خط که با خط تیره شروع شود، حداکثر ۱۰ نکته.
اصطلاحات تخصصی، فرمول‌ها، تعریف‌ها، نام‌ها و اعداد مهم را دقیق نگه دار؛ اصطلاح تخصصی انگلیسی را داخل پرانتز کنار معادل فارسی‌اش بگذار.
فقط همین بخش را خلاصه کن و مقدمه یا نتیجه‌گیری اضافه ننویس.`;

const COMBINE_SYSTEM_PROMPT = `تو دستیار درسی هستی. کاربر چند خلاصه‌ی پشت‌سرهم از بخش‌های یک سند درسی را می‌فرستد.
آن‌ها را به یک خلاصه‌ی فشرده‌ی واحد تبدیل کن: نکته‌های تکراری را یکی کن، ترتیب مطالب را حفظ کن، هر نکته یک خط با خط تیره در ابتدای آن، حداکثر ۸ نکته و هر نکته حداکثر دو جمله‌ی کوتاه.
اصطلاحات تخصصی، فرمول‌ها، نام‌ها و اعداد مهم را دقیق نگه دار. مقدمه ننویس.`;

// Used when merged partials refuse to get small enough to pair up: an even
// tighter rewrite, so its (much smaller) output cap always leaves room to merge.
const TIGHT_SYSTEM_PROMPT = `تو دستیار درسی هستی. کاربر یک خلاصه از بخشی از یک سند درسی را می‌فرستد.
آن را به یک خلاصه‌ی خیلی فشرده‌تر تبدیل کن: فقط مهم‌ترین نکته‌ها، هر نکته یک خط کوتاه با خط تیره در ابتدای آن، حداکثر ۵ نکته.
اصطلاحات تخصصی، فرمول‌ها، نام‌ها و اعداد مهم را دقیق نگه دار. مقدمه ننویس.`;

const FINAL_SYSTEM_PROMPT = `تو یک دستیار درسی فارسی هستی. کاربر خلاصه‌های پشت‌سرهم بخش‌های یک جزوه، اسلاید یا مقاله را می‌فرستد.
از روی آن‌ها یک خلاصه‌ی ساختاریافته برای مرور درسی بنویس: ابتدا در ۲ تا ۳ جمله موضوع کلی سند را بگو، سپس نکات کلیدی کل سند را به‌صورت خط به خط (هر نکته یک خط، با یک خط تیره در ابتدای آن) فهرست کن.
نکته‌های تکراری را یکی کن و ترتیب منطقی سند را حفظ کن. اصطلاحات تخصصی، فرمول‌ها، تعریف‌ها، نام افراد و اعداد مهم را دقیقاً حفظ کن.
مقدمه یا توضیح اضافه درباره‌ی «این یک خلاصه است» ننویس؛ مستقیم برو سر اصل مطلب. نقطه‌گذاری فارسی را درست رعایت کن.`;

// Completion caps (they count toward the per-minute budget, and gpt-oss spends
// part of them on reasoning, hence "low" effort below). Generous on purpose: a
// cap that reasoning eats entirely would return an empty answer.
const MAX_OUT = { single: 1300, map: 800, combine: 700, tight: 450, final: 1300 };

/**
 * One chat completion for the document flow. Resolves { text, totalTokens }
 * (totalTokens is Groq's reported usage, used to pace the next request).
 */
async function documentChat(systemPrompt, userText, maxTokens) {
  const body = {
    model: config.SUMMARY_MODEL,
    temperature: 0.3,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
  };
  // gpt-oss models reason before answering; on a tight token budget keep that short.
  if (/gpt-oss/i.test(config.SUMMARY_MODEL)) body.reasoning_effort = "low";

  const result = await groqFetch("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const choice = result.choices[0];
  const text = ((choice.message && choice.message.content) || "").trim();
  if (!text) {
    throw new Error(`Groq returned an empty completion (finish_reason: ${choice.finish_reason})`);
  }
  return { text, totalTokens: result.usage && result.usage.total_tokens };
}

// The model calls the long-document orchestrator needs. Prompt sizes are
// exported so it can budget chunk sizes from them.
const documentLlm = {
  single: (text) => documentChat(DOCUMENT_SYSTEM_PROMPT, text, MAX_OUT.single),
  mapChunk: (chunk) => documentChat(CHUNK_SYSTEM_PROMPT, chunk, MAX_OUT.map),
  combine: (partials, { final, tight } = {}) => {
    const joined = partials.join("\n\n");
    if (final) return documentChat(FINAL_SYSTEM_PROMPT, joined, MAX_OUT.final);
    if (tight) return documentChat(TIGHT_SYSTEM_PROMPT, joined, MAX_OUT.tight);
    return documentChat(COMBINE_SYSTEM_PROMPT, joined, MAX_OUT.combine);
  },
  promptChars: {
    single: DOCUMENT_SYSTEM_PROMPT.length,
    map: CHUNK_SYSTEM_PROMPT.length,
    combine: Math.max(COMBINE_SYSTEM_PROMPT.length, TIGHT_SYSTEM_PROMPT.length, FINAL_SYSTEM_PROMPT.length),
  },
  maxOut: MAX_OUT,
};

/**
 * Summarizes arbitrary document text (PDF lecture notes, slides, papers)
 * extracted via services/pdfText.js, in a single request. Kept as a separate
 * function/prompt from summarizeTranscript because spoken-voice transcripts
 * and written documents need different summarization instructions, even
 * though both go through the same Groq model/provider. For text too long to
 * fit the per-minute token budget in one request, use longSummarize.js.
 */
async function summarizeDocumentText(text) {
  console.log(`[summarize] requesting document summary for ${text.length}-char text...`);
  const { text: summary } = await documentLlm.single(text);
  console.log("[summarize] document summary received");
  return summary;
}

module.exports = { summarizeTranscript, summarizeDocumentText, documentLlm };

// Which way should the "🌐 ترجمه و ساده‌سازی متن" menu button translate?
//
//   mostly Persian (or other Arabic-script) text -> "toEnglish"
//   anything else (English, French, Russian, ...) -> "translate" (to simplified Persian)
//
// Decided by script, counted in WORDS: each word is classified by whether most
// of its letters are Arabic script, and the text is Persian if at least half of
// the words are. Counting words rather than letters matters: a Persian sentence
// with a couple of long English terms ("gradient descent") has more Latin
// letters than Persian ones, but is still Persian. Digits, punctuation and
// emoji are ignored. An exact 50/50 split counts as Persian, since that is how
// students usually write with English terms mixed in. Text with no letters at
// all defaults to "translate".

const LETTER = /\p{L}/gu;
const ARABIC_SCRIPT = /\p{Script=Arabic}/gu;

function isPersianWord(word) {
  const letters = word.match(LETTER);
  if (!letters) return null; // digits, symbols, emoji: not a word
  const arabic = word.match(ARABIC_SCRIPT);
  return (arabic ? arabic.length : 0) / letters.length >= 0.5;
}

/** Share of words that are Persian/Arabic script, or null if there are no words. */
function persianShare(text) {
  let words = 0;
  let persian = 0;
  for (const token of String(text).split(/[\s‌]+/)) {
    const isPersian = isPersianWord(token);
    if (isPersian === null) continue;
    words += 1;
    if (isPersian) persian += 1;
  }
  return words === 0 ? null : persian / words;
}

/** @returns {"toEnglish" | "translate"} */
function detectTranslationAction(text) {
  const share = persianShare(text);
  return share !== null && share >= 0.5 ? "toEnglish" : "translate";
}

module.exports = { detectTranslationAction, persianShare };

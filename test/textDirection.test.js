const test = require("node:test");
const assert = require("node:assert/strict");

const { detectTranslationAction, persianShare } = require("../src/services/textDirection");

// "translate" = to simplified Persian (input is not Persian); "toEnglish" = input is Persian.
const cases = [
  ["plain English", "Gradient descent minimizes a loss function.", "translate"],
  ["plain Persian", "گرادیان کاهشی تابع هزینه را کمینه می‌کند.", "toEnglish"],
  ["Persian with English terms", "در این جلسه درباره‌ی gradient descent و learning rate صحبت کردیم.", "toEnglish"],
  ["English with one Persian word", "The Persian word for backpack is کوله and it is used daily in class.", "translate"],
  ["Persian with digits and punctuation", "تکلیف ۲ تا ۱۵ آبان (۱۴۰۵) تحویل داده شود!", "toEnglish"],
  ["English with digits and punctuation", "Homework 2 is due on 15 November (2026)!", "translate"],
  ["Arabic script (Arabic) counts as Arabic script", "مرحبا بكم في الجامعة", "toEnglish"],
  ["French", "L'apprentissage automatique est une branche de l'intelligence artificielle.", "translate"],
  ["Russian", "Машинное обучение это раздел искусственного интеллекта.", "translate"],
  ["Chinese", "机器学习是人工智能的一个分支。", "translate"],
  ["only digits and symbols defaults to translate", "12345 + 678 = ???", "translate"],
  ["emoji only defaults to translate", "🎒🎒🎒", "translate"],
  ["empty", "", "translate"],
  ["short Persian word", "سلام", "toEnglish"],
  ["short English word", "hello", "translate"],
  ["exact half and half is treated as Persian", "abcd خودی", "toEnglish"],
  ["mostly English, some Persian", "hello world this is a test خودی", "translate"],
  ["Persian with a long English formula-like term", "معادله‌ی E = mc^2 نشان می‌دهد که جرم و انرژی معادل‌اند.", "toEnglish"],
];

for (const [name, text, expected] of cases) {
  test(`direction: ${name}`, () => {
    assert.equal(detectTranslationAction(text), expected, `share=${persianShare(text)}`);
  });
}

test("multi-line Persian and English documents are decided by the whole text", () => {
  assert.equal(detectTranslationAction("Introduction\n\nمقدمه\nاین بخش درباره‌ی مفاهیم پایه است.\nIt covers basics."), "toEnglish");
  assert.equal(detectTranslationAction("Introduction to machine learning.\nThis section covers the basics and more.\nمقدمه"), "translate");
});

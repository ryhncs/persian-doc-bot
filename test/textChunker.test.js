const test = require("node:test");
const assert = require("node:assert/strict");

const { splitIntoChunks } = require("../src/services/textChunker");

const squash = (s) => s.replace(/\s+/g, "");

test("short text is a single chunk", () => {
  assert.deepEqual(splitIntoChunks("hello\nworld", 100), ["hello\nworld"]);
});

test("every chunk fits, and no content is lost or reordered", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"word ".repeat(1 + (i % 9))}end.`);
  const text = lines.join("\n");
  const chunks = splitIntoChunks(text, 300);

  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 300, `chunk of ${c.length} chars exceeds 300`);
  assert.equal(squash(chunks.join("")), squash(text));
});

test("breaks between lines when it can rather than mid-line", () => {
  const chunks = splitIntoChunks("aaaa bbbb\ncccc dddd\neeee ffff", 20);
  assert.deepEqual(chunks, ["aaaa bbbb\ncccc dddd", "eeee ffff"]);
});

test("a line longer than a chunk is split on sentence ends (English and Persian punctuation)", () => {
  const text = "First sentence here. Second sentence here! سومین جمله اینجاست. چهارمین جمله؟ پنجم.";
  const chunks = splitIntoChunks(text, 30);
  for (const c of chunks) assert.ok(c.length <= 30);
  assert.equal(squash(chunks.join("")), squash(text));
  assert.ok(chunks.some((c) => c.endsWith("here.")), "kept a sentence intact at a boundary");
});

test("one enormous sentence falls back to splitting on spaces, then on raw length for unbreakable tokens", () => {
  const sentence = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  const chunks = splitIntoChunks(sentence, 40);
  for (const c of chunks) assert.ok(c.length <= 40);
  assert.equal(squash(chunks.join("")), squash(sentence));

  const url = "x".repeat(250);
  const urlChunks = splitIntoChunks(`see ${url} now`, 100);
  for (const c of urlChunks) assert.ok(c.length <= 100);
  assert.equal(squash(urlChunks.join("")), squash(`see ${url} now`));
});

test("blank lines and CRLF line endings are handled, and empty input gives no chunks", () => {
  assert.deepEqual(splitIntoChunks("a\r\n\r\n\r\nb", 100), ["a\nb"]);
  assert.deepEqual(splitIntoChunks("  \n \n", 100), []);
});

test("rejects a non-positive size", () => {
  assert.throws(() => splitIntoChunks("x", 0), /positive integer/);
});

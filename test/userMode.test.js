const test = require("node:test");
const assert = require("node:assert/strict");

const { createModeStore, MODES } = require("../src/services/userMode");
const { createClock } = require("./helpers");

test("a mode is consumed by exactly one matching take()", () => {
  const modes = createModeStore();
  modes.set(1, MODES.TRANSLATE);
  assert.equal(modes.take(1, MODES.TRANSLATE), MODES.TRANSLATE);
  assert.equal(modes.take(1, MODES.TRANSLATE), null);
});

test("take() with a different wanted mode leaves the mode in place", () => {
  const modes = createModeStore();
  modes.set(1, MODES.SUMMARIZE_PDF);
  assert.equal(modes.take(1, MODES.TRANSLATE), null);
  assert.equal(modes.peek(1), MODES.SUMMARIZE_PDF);
});

test("take() accepts several wanted modes and reports which one it was", () => {
  const modes = createModeStore();
  modes.set(1, MODES.COMPRESS);
  assert.equal(modes.take(1, MODES.SUMMARIZE_PDF, MODES.COMPRESS), MODES.COMPRESS);
});

test("a newer menu tap replaces the older mode", () => {
  const modes = createModeStore();
  modes.set(1, MODES.TRANSLATE);
  modes.set(1, MODES.COMPRESS);
  assert.equal(modes.peek(1), MODES.COMPRESS);
});

test("modes expire so a forgotten tap can't swallow a message much later", () => {
  const clock = createClock(0);
  const modes = createModeStore({ now: clock, ttlMs: 10 * 60 * 1000 });
  modes.set(1, MODES.TRANSLATE);
  clock.advance(9 * 60 * 1000);
  assert.equal(modes.peek(1), MODES.TRANSLATE);
  clock.advance(2 * 60 * 1000);
  assert.equal(modes.peek(1), null);
  assert.equal(modes.take(1, MODES.TRANSLATE), null);
});

test("clear() removes a mode, and users don't affect each other", () => {
  const modes = createModeStore();
  modes.set(1, MODES.TRANSLATE);
  modes.set(2, MODES.COMPRESS);
  modes.clear(1);
  assert.equal(modes.peek(1), null);
  assert.equal(modes.peek(2), MODES.COMPRESS);
});

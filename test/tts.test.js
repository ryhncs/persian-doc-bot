process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { prepareForSpeech, synthesizeSpeech, MAX_SPEECH_CHARS } = require("../src/services/tts");
const { createDailyCap } = require("../src/services/dailyCap");
const { convertToOggOpus } = require("../src/services/audioConvert");
const { createClock } = require("./helpers");

// --- prepareForSpeech ------------------------------------------------------------
test("bullets, markdown and emoji are removed, and every line ends with punctuation so the voice pauses", () => {
  const summary = ["📌 موضوع کلی سند", "- **نکته‌ی اول** درباره‌ی گرادیان", "• نکته‌ی دوم؟", "1. نکته‌ی سوم.", "", "* آخرین نکته"].join("\n");
  assert.equal(
    prepareForSpeech(summary),
    ["موضوع کلی سند.", "نکته‌ی اول درباره‌ی گرادیان.", "نکته‌ی دوم؟", "نکته‌ی سوم.", "آخرین نکته."].join("\n")
  );
});

test("nothing to say stays empty", () => {
  assert.equal(prepareForSpeech("  \n 🎒 \n- \n"), "");
});

// --- synthesizeSpeech (Edge is faked; the wiring around it is real) ----------------------
const MP3 = Buffer.alloc(1000, 1);

test("synthesizes the prepared text with the configured voice and returns the OGG audio", async () => {
  const calls = [];
  const audio = await synthesizeSpeech("- نکته‌ی اول\n- نکته‌ی دوم", {
    synthesize: async (text, voice) => {
      calls.push({ text, voice });
      return MP3;
    },
    toOgg: async (mp3) => Buffer.concat([Buffer.from("OggS"), mp3]),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "نکته‌ی اول.\nنکته‌ی دوم.");
  assert.equal(calls[0].voice, "fa-IR-DilaraNeural");
  assert.equal(audio.slice(0, 4).toString(), "OggS");
});

test("empty text, empty audio, over-long text and a hung endpoint all fail (so the request is refunded)", async () => {
  const ok = { synthesize: async () => MP3, toOgg: async (b) => b };
  await assert.rejects(() => synthesizeSpeech("🎒", ok), /Nothing to speak/);
  await assert.rejects(() => synthesizeSpeech("ب".repeat(MAX_SPEECH_CHARS + 10), ok), /too long/);
  await assert.rejects(() => synthesizeSpeech("سلام", { synthesize: async () => Buffer.alloc(3), toOgg: async (b) => b }), /no audio/);
  await assert.rejects(
    () => synthesizeSpeech("سلام", { synthesize: async () => { throw new Error("403 from endpoint"); }, toOgg: async (b) => b }),
    /403 from endpoint/
  );
});

// --- the real MP3 -> OGG/Opus step (uses the ffmpeg the bot ships) ---------------------------
test("convertToOggOpus produces an Ogg/Opus stream Telegram accepts as a voice note", async () => {
  const ffmpegPath = require("ffmpeg-static");
  const mp3Path = path.join(os.tmpdir(), `kooleh-test-${process.pid}.mp3`);
  execFileSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "24000", "-b:a", "48k", mp3Path], { stdio: "ignore" });
  try {
    const ogg = await convertToOggOpus(fs.readFileSync(mp3Path));
    assert.equal(ogg.slice(0, 4).toString(), "OggS");
    assert.ok(ogg.includes(Buffer.from("OpusHead")), "Opus codec");
  } finally {
    fs.rmSync(mp3Path, { force: true });
  }
});

// --- dailyCap ----------------------------------------------------------------------------------
test("the daily cap allows exactly `limit` per rolling 24 hours per user", () => {
  const clock = createClock();
  const cap = createDailyCap({ limit: 15, now: clock });
  for (let i = 0; i < 15; i++) assert.equal(cap.tryTake(1), true);
  assert.equal(cap.tryTake(1), false, "16th is refused");
  assert.equal(cap.tryTake(2), true, "other users are independent");

  clock.advance(24 * 60 * 60 * 1000 - 1000);
  assert.equal(cap.tryTake(1), false, "still inside the window");
  clock.advance(2000);
  assert.equal(cap.tryTake(1), true, "the window has rolled");
});

test("giving back a use frees the slot", () => {
  const cap = createDailyCap({ limit: 2 });
  assert.equal(cap.tryTake(1), true);
  assert.equal(cap.tryTake(1), true);
  assert.equal(cap.tryTake(1), false);
  cap.giveBack(1);
  assert.equal(cap.used(1), 1);
  assert.equal(cap.tryTake(1), true);
});

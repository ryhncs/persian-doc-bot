// "What is this user's next message for?" — set when they tap a menu button
// that expects input (translate a text, summarize a PDF, compress a file), and
// consumed by the next message of the matching kind. In memory with a short
// TTL, like sessionStore.js; losing it on a restart just means the user taps
// the button again.

const MODES = {
  TRANSLATE: "translate", // next text message -> translate & simplify
  SUMMARIZE_PDF: "summarizePdf", // next PDF -> summarize
  COMPRESS: "compress", // next photo or PDF -> compress
  TTS_TEXT: "ttsText", // next text message -> read it aloud as a voice message
};

const MODE_TTL_MS = 10 * 60 * 1000;

function createModeStore({ now = () => Date.now(), ttlMs = MODE_TTL_MS } = {}) {
  const modes = new Map(); // userId -> { mode, expiresAt }

  function peek(userId) {
    const entry = modes.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      modes.delete(userId);
      return null;
    }
    return entry.mode;
  }

  return {
    set(userId, mode) {
      modes.set(userId, { mode, expiresAt: now() + ttlMs });
    },
    peek,
    // Returns the mode (and clears it) only if it is one of `wanted`; otherwise null.
    take(userId, ...wanted) {
      const mode = peek(userId);
      if (mode && wanted.includes(mode)) {
        modes.delete(userId);
        return mode;
      }
      return null;
    },
    clear(userId) {
      modes.delete(userId);
    },
  };
}

const modes = createModeStore();

module.exports = { MODES, createModeStore, modes };

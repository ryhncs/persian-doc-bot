// Short-lived in-memory store bridging a voice reply's inline buttons back to
// the transcript/summary that produced it (Telegram callback_data is capped
// at 64 bytes, far too small to hold the content itself).
//
// Redis/DB upgrade path: same key -> JSON blob, with a TTL instead of the
// sweep interval below. Needed once this runs across multiple instances.

const crypto = require("crypto");

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const sessions = new Map();

function createSession({ userId, chatId, transcript, summary }) {
  const id = crypto.randomBytes(5).toString("hex");
  sessions.set(id, { userId, chatId, transcript, summary, createdAt: Date.now() });
  return id;
}

function getSession(id) {
  return sessions.get(id);
}

const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 30 * 60 * 1000);
sweepInterval.unref();

module.exports = { createSession, getSession };

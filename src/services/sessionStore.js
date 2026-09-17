// Short-lived in-memory store bridging inline buttons back to whatever data
// produced them (Telegram callback_data is capped at 64 bytes, far too
// small to hold the content itself). Originally just {userId, chatId,
// transcript, summary} for the voice-summary flow; genericized to accept
// any fields so the PDF-choice flow can store {userId, chatId, fileId,
// fileName} in the same store instead of a second one.
//
// Redis/DB upgrade path: same key -> JSON blob, with a TTL instead of the
// sweep interval below. Needed once this runs across multiple instances.

const crypto = require("crypto");

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const sessions = new Map();

function createSession(data) {
  const id = crypto.randomBytes(5).toString("hex");
  sessions.set(id, { ...data, createdAt: Date.now() });
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

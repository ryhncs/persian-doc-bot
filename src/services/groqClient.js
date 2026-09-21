const config = require("../config");

const BASE_URL = "https://api.groq.com/openai/v1";

class GroqApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GroqApiError";
    this.status = status;
  }
}

class GroqRateLimitError extends GroqApiError {
  // retryAfterMs: from Groq's Retry-After header when present, else undefined.
  constructor(message, retryAfterMs) {
    super(message, 429);
    this.name = "GroqRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Thin wrapper around Groq's OpenAI-compatible REST endpoints. No SDK — just
 * fetch with the auth header attached, and error responses normalized into
 * GroqApiError/GroqRateLimitError so callers can branch on them.
 */
const DEFAULT_TIMEOUT_MS = 60 * 1000;

async function groqFetch(path, { timeoutMs = DEFAULT_TIMEOUT_MS, ...options } = {}) {
  if (!config.GROQ_API_KEY) {
    throw new GroqApiError("GROQ_API_KEY is not configured", 0);
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${config.GROQ_API_KEY}`,
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new GroqApiError(`Groq request timed out after ${timeoutMs}ms`, 0);
    }
    throw err;
  }

  if (res.status === 429) {
    const header = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
    const seconds = header ? Number(header) : NaN;
    throw new GroqRateLimitError(
      "Groq rate limit exceeded (429)",
      Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = (body && body.error && body.error.message) || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new GroqApiError(`Groq API error ${res.status}: ${detail}`, res.status);
  }

  return res.json();
}

module.exports = { groqFetch, GroqApiError, GroqRateLimitError };

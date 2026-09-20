const DAY_MS = 24 * 60 * 60 * 1000;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 150000 -> "۱۵۰٬۰۰۰". Falls back to the raw string if it isn't numeric, so a
// price configured as e.g. "۱۵۰ هزار" still renders as-is.
function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString("fa-IR");
}

// Jalali (Persian calendar) date, e.g. "۲۸ مهر ۱۴۰۵".
function formatPersianDate(ms) {
  return new Date(ms).toLocaleDateString("fa-IR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function daysUntil(ms, now) {
  return Math.max(1, Math.ceil((ms - now) / DAY_MS));
}

module.exports = { DAY_MS, escapeHtml, formatNumber, formatPersianDate, daysUntil };

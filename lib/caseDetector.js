// Matches messages like "3 มาโนชญ", "01ภาสกร", "7 จำลอง", "10 พุทธิพงษ์"
// Rule: starts with 1-3 digits (bed/HN number), optional space,
// then a name made of Thai/English letters and spaces (no more digits,
// no punctuation) — this deliberately excludes times like "6:44" or
// phone numbers like "081-234-5678".
const CASE_PATTERN = /^(\d{1,3})\s*([ก-๙A-Za-z][ก-๙A-Za-z\s.'-]*)$/u;

// Explicit commands never get treated as a case even if they'd match.
const COMMANDS = new Set(["/status", "/undo", "/summary", "/help"]);

function detectCase(rawText) {
  const text = (rawText || "").trim();
  if (!text || COMMANDS.has(text.toLowerCase())) return null;

  const match = text.match(CASE_PATTERN);
  if (!match) return null;

  const bedNumber = match[1];
  const patientName = match[2].trim();
  if (!patientName) return null;

  return { bedNumber, patientName, rawText: text };
}

module.exports = { detectCase, CASE_PATTERN };

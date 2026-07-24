// Detects one or more "bed number + patient name" cases in a single
// message, e.g. "3 มาโนชญ" or "3 มาโนชญ 5 สมศรี" (two cases) or even
// "01ภาสกร" (number and name with no space between them).
//
// Strategy: split the message into whitespace tokens, then walk through
// them. A token is either:
//   - a "concatenated" case on its own, e.g. "01ภาสกร" (digits directly
//     followed by letters, no space)
//   - a pure number token, e.g. "3" or "01" — this starts a new case,
//     and every following token is treated as part of that patient's
//     name UNTIL the next number token (or concatenated case token)
//     appears, which starts the next case.
//
// This deliberately excludes tokens like "6:44" (colon, not a letter)
// or "081-234-5678" (hyphens, not a letter) so timestamps and phone
// numbers never get mistaken for a case.

const NUMBER_TOKEN = /^\d{1,3}$/;
const CONCATENATED_TOKEN = /^(\d{1,3})([ก-๙A-Za-z][ก-๙A-Za-z.'-]*)$/u;

// Explicit commands never get treated as a case even if they'd match.
const COMMANDS = new Set(["/status", "/undo", "/summary", "/help", "/allcase", "/announce"]);

function matchConcatenated(token) {
  const m = token.match(CONCATENATED_TOKEN);
  return m ? { bedNumber: m[1], namePart: m[2] } : null;
}

function detectCases(rawText) {
  const text = (rawText || "").trim();
  if (!text || COMMANDS.has(text.toLowerCase())) return [];

  const tokens = text.split(/\s+/);
  const cases = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    const concatenated = matchConcatenated(token);

    if (concatenated) {
      cases.push({
        bedNumber: concatenated.bedNumber,
        patientName: concatenated.namePart.trim(),
      });
      i++;
      continue;
    }

    if (NUMBER_TOKEN.test(token)) {
      const bedNumber = token;
      i++;
      const nameParts = [];
      while (
        i < tokens.length &&
        !NUMBER_TOKEN.test(tokens[i]) &&
        !matchConcatenated(tokens[i])
      ) {
        nameParts.push(tokens[i]);
        i++;
      }
      const patientName = nameParts.join(" ").trim();
      if (patientName) cases.push({ bedNumber, patientName });
      continue;
    }

    // A stray token before any valid case has started means this whole
    // message isn't case data — e.g. "เบื่อจังเลยอยากกิน 6 ไก่กา" should
    // NOT register "6 ไก่กา" as a case. Reject the whole message rather
    // than skipping the junk and continuing to scan.
    return [];
  }

  return cases.map((c) => ({
    bedNumber: c.bedNumber,
    patientName: c.patientName,
    rawText: `${c.bedNumber} ${c.patientName}`,
  }));
}

// ---- Discharge detection: "3 d/c", "3 มาโนชญ d/c", or "3 d/c 5 d/c" ----
// Each group is: a bed number, an optional name, then a "d/c" (or "dc")
// token that closes the group. Unlike case-adding, "d/c" is an
// unambiguous stop marker, so we can safely require the ENTIRE message
// to be made of nothing but these groups — any leftover token anywhere
// (leading, trailing, or between groups) rejects the whole message.
const DISCHARGE_TOKEN = /^d\/?c[.,]?$/i;

function detectDischarges(rawText) {
  const text = (rawText || "").trim();
  if (!text) return [];

  const tokens = text.split(/\s+/);
  const beds = [];
  let i = 0;

  while (i < tokens.length) {
    if (!NUMBER_TOKEN.test(tokens[i])) return []; // must start each group with a bed number
    const bedNumber = tokens[i];
    i++;

    // Skip an optional patient name between the bed number and "d/c".
    while (
      i < tokens.length &&
      !NUMBER_TOKEN.test(tokens[i]) &&
      !DISCHARGE_TOKEN.test(tokens[i]) &&
      !matchConcatenated(tokens[i])
    ) {
      i++;
    }

    if (i >= tokens.length || !DISCHARGE_TOKEN.test(tokens[i])) return []; // group never closed with "d/c"
    beds.push(bedNumber);
    i++; // consume the "d/c" token
  }

  return beds;
}

// ---- Manual assignment: "8 สมศรี jennie" ----
// bed number, then patient name (1+ words), then a name from validNames
// (case-insensitive) as the last token. Returns null if the message
// doesn't end in a recognized name, so normal case-logging still works
// for ordinary messages.
function detectManualAssignment(rawText, validNames) {
  const text = (rawText || "").trim();
  if (!text) return null;

  const tokens = text.split(/\s+/);
  if (tokens.length < 3) return null;

  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (!NUMBER_TOKEN.test(first)) return null;

  const matchedName = (validNames || []).find(
    (n) => n.toLowerCase() === last.toLowerCase()
  );
  if (!matchedName) return null;

  const patientName = tokens.slice(1, tokens.length - 1).join(" ").trim();
  if (!patientName) return null;

  return {
    bedNumber: first,
    patientName,
    assignedTo: matchedName,
    rawText: `${first} ${patientName}`,
  };
}

module.exports = { detectCases, detectDischarges, detectManualAssignment };

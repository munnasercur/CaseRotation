const { google } = require("googleapis");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const LOG_TAB = "Log";
const CONFIG_TAB = "Config";

let sheetsClient = null;

function getClient() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Render/Railway env vars store \n literally — convert back to real newlines.
    key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// ---- Log tab: one row per case ----
// Columns: Timestamp | BedNumber | PatientName | AssignedTo | RawText

async function appendCase({ bedNumber, patientName, assignedTo, rawText }) {
  const sheets = getClient();
  const timestamp = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${LOG_TAB}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[timestamp, bedNumber, patientName, assignedTo, rawText]],
    },
  });
}

async function getAllCases() {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${LOG_TAB}!A2:E`,
  });
  const rows = res.data.values || [];
  return rows.map((r) => ({
    timestamp: r[0],
    bedNumber: r[1],
    patientName: r[2],
    assignedTo: r[3],
    rawText: r[4],
  }));
}

async function getCaseCount() {
  const cases = await getAllCases();
  return cases.length;
}

async function getRecentCases(hours = 24) {
  const cases = await getAllCases();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return cases.filter((c) => new Date(c.timestamp).getTime() >= cutoff);
}

// Removes the last row from the Log tab. Used by /undo.
async function undoLastCase() {
  const sheets = getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const logSheet = meta.data.sheets.find(
    (s) => s.properties.title === LOG_TAB
  );
  if (!logSheet) throw new Error(`Sheet tab "${LOG_TAB}" not found`);
  const sheetId = logSheet.properties.sheetId;

  const cases = await getAllCases();
  if (cases.length === 0) return null;

  const lastRowIndex = cases.length; // 0-indexed data rows start at sheet row 2 (index 1)
  const removed = cases[cases.length - 1];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: lastRowIndex, // row 2 + (count-1), i.e. the last data row
              endIndex: lastRowIndex + 1,
            },
          },
        },
      ],
    },
  });

  return removed;
}

// ---- Config tab: simple key/value store, e.g. groupId ----

async function getConfig(key) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${CONFIG_TAB}!A2:B`,
  });
  const rows = res.data.values || [];
  const row = rows.find((r) => r[0] === key);
  return row ? row[1] : null;
}

async function setConfig(key, value) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${CONFIG_TAB}!A2:B`,
  });
  const rows = res.data.values || [];
  const existingIndex = rows.findIndex((r) => r[0] === key);

  if (existingIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${CONFIG_TAB}!A:B`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[key, value]] },
    });
  } else {
    const rowNumber = existingIndex + 2; // account for header row
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CONFIG_TAB}!A${rowNumber}:B${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[key, value]] },
    });
  }
}

module.exports = {
  appendCase,
  getAllCases,
  getCaseCount,
  getRecentCases,
  undoLastCase,
  getConfig,
  setConfig,
};

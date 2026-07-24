require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const cron = require("node-cron");

const {
  detectCases,
  detectDischarges,
  detectManualAssignment,
} = require("./lib/caseDetector");
const { ORDER } = require("./lib/rotation");
const sheets = require("./lib/sheets");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// Sent when someone types /announce — trigger it once after you deploy
// real feature updates so the group knows what's new. Not automatic on
// every deploy, so small fixes don't spam the group.
const ANNOUNCEMENT_MESSAGE =
  "📢 อัปเดตขุนทองเวอร์ชั่นเล็ก!\n\n" +
  "ฟีเจอร์ใหม่:\n" +
  "• จำหน่ายผู้ป่วย: พิมพ์ 'เตียง d/c' เช่น '3 d/c' (พิมพ์ต่อกันหลายเตียงได้ เช่น '3 d/c 5 d/c') — ไม่กระทบคิวเลย\n" +
  "• ดูเคส Active ทั้งหมด: พิมพ์ /allcase\n" +
  "• มอบหมายเองได้: พิมพ์ 'เตียง ชื่อ คนรับ' เช่น '8 สมศรี jennie' → คิวจะขยับไปคนถัดจาก jennie ให้อัตโนมัติ\n\n" +
  "พิมพ์ /help เพื่อดูคำสั่งทั้งหมดอีกครั้งครับ";

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ---- Rotation pointer ----
// "Next up" is stored explicitly in the Config tab (key: nextAssigneeIndex)
// rather than derived from a case count. This is required so manual
// assignment (#3) can correctly move the pointer to "whoever comes after
// the manually-assigned person" without disturbing anything else.
async function getNextIndex() {
  const stored = await sheets.getConfig("nextAssigneeIndex");
  if (stored !== null && stored !== undefined && stored !== "") {
    return parseInt(stored, 10);
  }
  // First run after upgrading from the old count-based version — derive
  // a starting point from existing cases so the rotation doesn't reset
  // to Munna out of nowhere, then persist it going forward.
  const count = await sheets.getCaseCount();
  const idx = count % ORDER.length;
  await sheets.setConfig("nextAssigneeIndex", String(idx));
  return idx;
}

async function setNextIndex(idx) {
  const wrapped = ((idx % ORDER.length) + ORDER.length) % ORDER.length;
  await sheets.setConfig("nextAssigneeIndex", String(wrapped));
}

const app = express();

app.get("/", (_req, res) => res.send("KhunThong-lite is running."));

app.post(
  "/webhook",
  line.middleware(config),
  async (req, res) => {
    // Respond fast so LINE doesn't retry; process events after.
    res.sendStatus(200);
    try {
      await Promise.all(req.body.events.map(handleEvent));
    } catch (err) {
      console.error("Error handling events:", err);
    }
  }
);

async function handleEvent(event) {
  // Remember the group so scheduled summaries know where to post.
  if (event.source && event.source.type === "group") {
    const known = await sheets.getConfig("groupId");
    if (known !== event.source.groupId) {
      await sheets.setConfig("groupId", event.source.groupId);
    }
  }

  if (event.type === "join" && event.source.type === "group") {
    return reply(event.replyToken, [
      textMessage(
        "สวัสดีครับ ผมขุนทองเวอร์ชั่นเล็ก 🐦\n" +
          "พิมพ์เคสใหม่ในรูปแบบ 'เตียง ชื่อ' เช่น '3 มาโนชญ' แล้วผมจะมอบหมายให้อัตโนมัติ\n" +
          "คำสั่ง: /status /allcase /undo /summary /help"
      ),
    ]);
  }

  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  if (text === "/help") {
    return reply(event.replyToken, [
      textMessage(
        "วิธีใช้:\n" +
          "• พิมพ์ 'เตียง ชื่อ' เช่น '3 มาโนชญ' เพื่อลงเคสใหม่ → มอบหมายอัตโนมัติตามคิว (พิมพ์ต่อกันได้หลายเคส เช่น '3 มาโนชญ 5 สมศรี')\n" +
          "• 'เตียง d/c' เช่น '3 d/c' → จำหน่ายผู้ป่วยเตียงนั้น (ไม่กระทบคิว) พิมพ์ต่อกันได้ เช่น '3 d/c 5 d/c'\n" +
          "• 'เตียง ชื่อ คนรับ' เช่น '8 สมศรี jennie' → มอบหมายเคสนี้ให้คนที่ระบุเอง (คิวจะขยับไปคนถัดจากคนนั้น)\n" +
          "• /allcase → ดูเคส Active ทั้งหมด แยกตามเจ้าของเคส (ไม่รวมที่จำหน่ายแล้ว)\n" +
          "• /status → ดูคิวถัดไปและเคสล่าสุด\n" +
          "• /undo → ลบเคสล่าสุด (เผื่อลงผิด) และคืนคิวกลับ\n" +
          "• /summary → สรุปเคสของแต่ละคนใน 3 วันที่ผ่านมา"
      ),
    ]);
  }

  if (text === "/status") {
    const nextIndex = await getNextIndex();
    const next = ORDER[nextIndex];
    const cases = await sheets.getAllCases();
    const last = cases.slice(-3).reverse();
    const lastLines = last.length
      ? last
          .map(
            (c) =>
              `  • เตียง ${c.bedNumber} ${c.patientName} → ${c.assignedTo}` +
              (c.status === "Discharged" ? " (จำหน่ายแล้ว)" : "")
          )
          .join("\n")
      : "  (ยังไม่มีเคส)";
    return reply(event.replyToken, [
      textMessage(`คิวถัดไป: ${next}\n\nเคสล่าสุด:\n${lastLines}`),
    ]);
  }

  if (text === "/allcase") {
    const message = await buildActiveCaseMessage();
    return reply(event.replyToken, [textMessage(message)]);
  }

  if (text === "/undo") {
    const removed = await sheets.undoLastCase();
    if (!removed) {
      return reply(event.replyToken, [textMessage("ไม่มีเคสให้ลบครับ")]);
    }
    // Put the queue back to how it was before this case was logged —
    // whoever it was assigned to becomes "next" again.
    const revertIdx = ORDER.findIndex(
      (n) => n.toLowerCase() === removed.assignedTo.toLowerCase()
    );
    if (revertIdx !== -1) await setNextIndex(revertIdx);
    return reply(event.replyToken, [
      textMessage(
        `ลบแล้ว: เตียง ${removed.bedNumber} ${removed.patientName} (เดิมมอบหมายให้ ${removed.assignedTo})\n` +
          `คิวถัดไปกลับเป็น: ${removed.assignedTo}`
      ),
    ]);
  }

  if (text === "/summary") {
    const message = await buildSummaryMessage();
    return reply(event.replyToken, [textMessage(message)]);
  }

  if (text === "/announce") {
    return reply(event.replyToken, [textMessage(ANNOUNCEMENT_MESSAGE)]);
  }

  // ---- Discharge: "3 d/c" or "3 d/c 5 d/c" ----
  // Checked before case detection since "d/c" would otherwise look like
  // a (nonsensical) patient name. Discharging never touches the queue.
  const dischargeBeds = detectDischarges(text);
  if (dischargeBeds.length > 0) {
    const results = [];
    for (const bed of dischargeBeds) {
      const removed = await sheets.dischargeCase(bed);
      results.push({ bed, removed });
    }
    const lines = results
      .map((r) =>
        r.removed
          ? `✅ จำหน่ายเตียง ${r.bed} (${r.removed.patientName}) แล้ว`
          : `⚠️ ไม่พบเตียง ${r.bed} ที่ยัง Active อยู่`
      )
      .join("\n");
    return reply(event.replyToken, [textMessage(lines)]);
  }

  // ---- Manual assignment: "8 สมศรี jennie" ----
  // Checked before regular case detection, since a message ending in a
  // recognized name should be treated as an explicit override, not a
  // patient literally named "Jennie". Moves the queue to whoever comes
  // after the manually-assigned person in the fixed order.
  const manual = detectManualAssignment(text, ORDER);
  if (manual) {
    await sheets.appendCase({
      bedNumber: manual.bedNumber,
      patientName: manual.patientName,
      assignedTo: manual.assignedTo,
      rawText: manual.rawText,
    });
    const assigneeIdx = ORDER.findIndex(
      (n) => n.toLowerCase() === manual.assignedTo.toLowerCase()
    );
    const newNextIndex = (assigneeIdx + 1) % ORDER.length;
    await setNextIndex(newNextIndex);
    const upcoming = ORDER[newNextIndex];
    return reply(event.replyToken, [
      textMessage(
        `🆕 เตียง ${manual.bedNumber} ${manual.patientName} → มอบหมายให้ ${manual.assignedTo} (manual)\n` +
          `คิวถัดไป: ${upcoming}`
      ),
    ]);
  }

  // ---- Regular case detection (one or more cases per message) ----
  const detectedCases = detectCases(text);
  if (detectedCases.length === 0) return;

  let nextIndex = await getNextIndex();
  const assignments = [];

  for (const c of detectedCases) {
    const assignedTo = ORDER[nextIndex];
    await sheets.appendCase({
      bedNumber: c.bedNumber,
      patientName: c.patientName,
      assignedTo,
      rawText: c.rawText,
    });
    assignments.push({ ...c, assignedTo });
    nextIndex = (nextIndex + 1) % ORDER.length;
  }
  await setNextIndex(nextIndex);

  const upcoming = ORDER[nextIndex];
  const lines = assignments
    .map((a) => `🆕 เตียง ${a.bedNumber} ${a.patientName} → ${a.assignedTo}`)
    .join("\n");

  return reply(event.replyToken, [
    textMessage(`${lines}\n\nคิวถัดไป: ${upcoming}`),
  ]);
}

function textMessage(text) {
  return { type: "text", text };
}

async function reply(replyToken, messages) {
  return client.replyMessage({ replyToken, messages });
}

// Groups cases by assignee, formatted like "Jennie (2):\n  เตียง 3 ...\n  เตียง 5 ...".
function groupCasesByOwner(cases) {
  const byPerson = {};
  for (const c of cases) {
    byPerson[c.assignedTo] = byPerson[c.assignedTo] || [];
    byPerson[c.assignedTo].push(`เตียง ${c.bedNumber} ${c.patientName}`);
  }
  return Object.entries(byPerson).map(
    ([person, items]) => `${person} (${items.length}):\n  ${items.join("\n  ")}`
  );
}

async function buildSummaryMessage(hours = 72) {
  const recent = await sheets.getRecentCases(hours);
  if (recent.length === 0) {
    return "ยังไม่มีเคสใหม่ในช่วง 3 วันที่ผ่านมาครับ";
  }
  const lines = groupCasesByOwner(recent);
  return `สรุปเคส 3 วันที่ผ่านมา:\n\n${lines.join("\n\n")}`;
}

// All currently-active (non-discharged) cases, grouped by owner —
// used by both /allcase and the 6 AM auto-message.
async function buildActiveCaseMessage() {
  const active = await sheets.getActiveCases();
  if (active.length === 0) {
    return "ไม่มีเคส Active ในตอนนี้ครับ";
  }
  const sorted = [...active].sort(
    (a, b) => parseInt(a.bedNumber, 10) - parseInt(b.bedNumber, 10)
  );
  const lines = groupCasesByOwner(sorted);
  return `เคส Active ทั้งหมด (${active.length}):\n\n${lines.join("\n\n")}`;
}

// ---- Daily automatic message, 6:00 AM Bangkok time ----
// Sends the active-case breakdown (same as /allcase) instead of the
// 3-day summary, so the morning message shows exactly who owns what
// right now.
cron.schedule(
  "0 6 * * *",
  async () => {
    try {
      const groupId = await sheets.getConfig("groupId");
      if (!groupId) return; // bot hasn't been added to a group yet
      const message = await buildActiveCaseMessage();
      await client.pushMessage({ to: groupId, messages: [textMessage(message)] });
    } catch (err) {
      console.error("Error sending daily active-case message:", err);
    }
  },
  { timezone: "Asia/Bangkok" }
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`KhunThong-lite listening on port ${port}`));

// ---- Keep-alive self-ping ----
// Render's free tier spins the service down after ~15 minutes with no
// incoming HTTP requests. That breaks two things: node-cron never fires
// (the whole process is asleep at 6 AM), and the *first* message after a
// quiet stretch times out while the instance cold-starts, so the reply
// silently fails and you have to send it again. Pinging our own public
// URL every 10 minutes creates genuine inbound traffic, so Render never
// sees the service go idle and never spins it down.
// RENDER_EXTERNAL_URL is set automatically by Render for web services —
// no manual configuration needed.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  cron.schedule("*/10 * * * *", () => {
    fetch(SELF_URL).catch((err) =>
      console.error("Self-ping failed:", err.message)
    );
  });
} else {
  console.warn(
    "RENDER_EXTERNAL_URL not set — skipping self-ping. If deployed on " +
      "Render this should be set automatically; on other hosts this " +
      "keep-alive trick isn't needed/applicable."
  );
}

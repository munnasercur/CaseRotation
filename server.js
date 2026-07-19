require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const cron = require("node-cron");

const { detectCases } = require("./lib/caseDetector");
const { whoIsNext } = require("./lib/rotation");
const sheets = require("./lib/sheets");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

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
          "คำสั่ง: /status /undo /summary /help"
      ),
    ]);
  }

  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  if (text === "/help") {
    return reply(event.replyToken, [
      textMessage(
        "วิธีใช้:\n" +
          "• พิมพ์ 'เตียง ชื่อ' เช่น '3 มาโนชญ' เพื่อลงเคสใหม่ → มอบหมายอัตโนมัติตามคิว\n" +
          "• /status → ดูคิวปัจจุบันและเคสล่าสุด\n" +
          "• /undo → ลบเคสล่าสุด (เผื่อลงผิด)\n" +
          "• /summary → สรุปเคสของแต่ละคนใน 3 วันที่ผ่านมา"
      ),
    ]);
  }

  if (text === "/status") {
    const count = await sheets.getCaseCount();
    const next = whoIsNext(count);
    const cases = await sheets.getAllCases();
    const last = cases.slice(-3).reverse();
    const lastLines = last.length
      ? last
          .map((c) => `  • เตียง ${c.bedNumber} ${c.patientName} → ${c.assignedTo}`)
          .join("\n")
      : "  (ยังไม่มีเคส)";
    return reply(event.replyToken, [
      textMessage(`คิวถัดไป: ${next}\n\nเคสล่าสุด:\n${lastLines}`),
    ]);
  }

  if (text === "/undo") {
    const removed = await sheets.undoLastCase();
    if (!removed) {
      return reply(event.replyToken, [textMessage("ไม่มีเคสให้ลบครับ")]);
    }
    return reply(event.replyToken, [
      textMessage(
        `ลบแล้ว: เตียง ${removed.bedNumber} ${removed.patientName} (เดิมมอบหมายให้ ${removed.assignedTo})`
      ),
    ]);
  }

  if (text === "/summary") {
    const message = await buildSummaryMessage();
    return reply(event.replyToken, [textMessage(message)]);
  }

  // Otherwise, check if this looks like one or more new cases.
  const detectedCases = detectCases(text);
  if (detectedCases.length === 0) return;

  let count = await sheets.getCaseCount();
  const assignments = [];

  // Assign and log each case in order, so a message with several cases
  // correctly hands them to consecutive people in the rotation.
  for (const c of detectedCases) {
    const assignedTo = whoIsNext(count);
    await sheets.appendCase({
      bedNumber: c.bedNumber,
      patientName: c.patientName,
      assignedTo,
      rawText: c.rawText,
    });
    assignments.push({ ...c, assignedTo });
    count++;
  }

  const upcoming = whoIsNext(count);
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

async function buildSummaryMessage(hours = 72) {
  const recent = await sheets.getRecentCases(hours);
  if (recent.length === 0) {
    return "ยังไม่มีเคสใหม่ในช่วง 3 วันที่ผ่านมาครับ";
  }
  const byPerson = {};
  for (const c of recent) {
    byPerson[c.assignedTo] = byPerson[c.assignedTo] || [];
    byPerson[c.assignedTo].push(`เตียง ${c.bedNumber} ${c.patientName}`);
  }
  const lines = Object.entries(byPerson).map(
    ([person, items]) => `${person} (${items.length}):\n  ${items.join("\n  ")}`
  );
  return `สรุปเคส 3 วันที่ผ่านมา:\n\n${lines.join("\n\n")}`;
}

// ---- Daily automatic summary, 6:00 AM Bangkok time ----
cron.schedule(
  "0 6 * * *",
  async () => {
    try {
      const groupId = await sheets.getConfig("groupId");
      if (!groupId) return; // bot hasn't been added to a group yet
      const message = await buildSummaryMessage();
      await client.pushMessage({ to: groupId, messages: [textMessage(message)] });
    } catch (err) {
      console.error("Error sending daily summary:", err);
    }
  },
  { timezone: "Asia/Bangkok" }
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`KhunThong-lite listening on port ${port}`));

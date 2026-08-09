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
  "รอบเวรใหม่: Peem → Jennie → Munna (วนซ้ำ) เริ่มคิวแรกที่ Peem\n\n" +
  "การเปลี่ยนแปลงสำคัญ:\n" +
  "• ตอนนี้ก่อนลงเคส/จำหน่าย/มอบหมายเอง ต้องพิมพ์ /activate ก่อนเสมอ (บอทจะตอบ 'พร้อมแล้วครับ') แล้วพิมพ์คำสั่งนั้นในข้อความถัดไปทันที — ใช้ได้ครั้งเดียวต่อ /activate หนึ่งครั้ง เพื่อกันบอทอ่านข้อความแชทปกติที่ขึ้นต้นด้วยตัวเลขผิดพลาด (เช่น '3 คนแล้วที่ยังไม่ได้กินข้าว')\n" +
  "• คำสั่งอื่นๆ อย่าง /status /allcase /todaycase /undo /setnext ยังใช้ได้ปกติ ไม่ต้อง /activate ก่อน\n\n" +
  "พิมพ์ /help เพื่อดูคำสั่งทั้งหมดอีกครั้งครับ";

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ---- Rotation pointer ----
// "Next up" is stored explicitly in the Config tab (key: nextAssigneeIndex)
// rather than derived from a case count. This is required so manual
// assignment can correctly move the pointer to "whoever comes after the
// manually-assigned person" without disturbing anything else.
async function getNextIndex() {
  const stored = await sheets.getConfig("nextAssigneeIndex");
  if (stored !== null && stored !== undefined && stored !== "") {
    return parseInt(stored, 10);
  }
  // First run after upgrading from the old count-based version — derive
  // a starting point from existing cases so the rotation doesn't reset
  // to ORDER[0] out of nowhere, then persist it going forward.
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

// ---- One-shot activation gate ----
// Ordinary chat messages that happen to start with a number (e.g. "3
// อยากกินข้าว") could still get misread as a case. As an extra safety
// net on top of the strict parsing, number-starting prompts (new case,
// discharge, manual assignment) now require the group to type /activate
// immediately before each one. It's a one-shot token: it's consumed by
// the very next message regardless of whether that message turns out to
// be a valid prompt, so it can't stay silently "armed" and catch a later
// unrelated message. Named "/xxx" commands (like /status) never require
// this, since they're unambiguous exact matches, not number-starting
// text. This is in-memory only (not persisted to the Sheet) since it's
// meant to be a short-lived, per-message token, not durable state.
const activatedSources = new Set();

function sourceKey(event) {
  const s = event.source;
  if (!s) return null;
  if (s.type === "group") return `group:${s.groupId}`;
  if (s.type === "room") return `room:${s.roomId}`;
  if (s.type === "user") return `user:${s.userId}`;
  return null;
}

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
          "ก่อนลงเคส/จำหน่าย/มอบหมายเอง ต้องพิมพ์ /activate ก่อนเสมอ (กันบอทอ่านข้อความอื่นที่ขึ้นต้นด้วยตัวเลขผิดพลาด) แล้วพิมพ์เคสในข้อความถัดไป เช่น '3 มาโนชญ'\n" +
          "คำสั่ง: /status /allcase /todaycase /undo /help"
      ),
    ]);
  }

  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();

  if (text === "/activate") {
    const key = sourceKey(event);
    if (key) activatedSources.add(key);
    return reply(event.replyToken, [textMessage("พร้อมแล้วครับ")]);
  }

  // Consume the one-shot activation token now, regardless of what this
  // message turns out to be — see comment above activatedSources.
  const key = sourceKey(event);
  let isActivated = false;
  if (key && activatedSources.has(key)) {
    isActivated = true;
    activatedSources.delete(key);
  }

  if (text === "/help") {
    return reply(event.replyToken, [
      textMessage(
        "วิธีใช้:\n" +
          "• ก่อนพิมพ์เคส/จำหน่าย/มอบหมายเอง ต้องพิมพ์ /activate ก่อนเสมอ (บอทจะตอบ 'พร้อมแล้วครับ') แล้วพิมพ์คำสั่งนั้นในข้อความถัดไปทันที — ใช้ได้ครั้งเดียวต่อหนึ่ง /activate กันบอทอ่านข้อความอื่นที่ขึ้นต้นด้วยตัวเลขผิดพลาด\n" +
          "• พิมพ์ 'เตียง ชื่อ' เช่น '3 มาโนชญ' เพื่อลงเคสใหม่ → มอบหมายอัตโนมัติตามคิว (พิมพ์ต่อกันได้หลายเคส เช่น '3 มาโนชญ 5 สมศรี')\n" +
          "• 'เตียง ชื่อ d/c' เช่น '3 มาโนชญ d/c' → จำหน่ายผู้ป่วยเตียงนั้น (ต้องระบุชื่อด้วยเสมอ กันจำหน่ายผิดคนเวลาเตียงถูกใช้ซ้ำ) พิมพ์ต่อกันได้ เช่น '3 มาโนชญ d/c 5 สมศรี d/c' — ไม่กระทบคิว\n" +
          "• 'เตียง ชื่อ คนรับ' เช่น '8 สมศรี jennie' → มอบหมายเคสนี้ให้คนที่ระบุเอง (คิวจะขยับไปคนถัดจากคนนั้น)\n" +
          "• /allcase หรือ /summary → ดูเคส Active ทั้งหมด แยกตามเจ้าของเคส (ไม่รวมที่จำหน่ายแล้ว ไม่จำกัดวัน) — ไม่ต้อง /activate\n" +
          "• /todaycase → ดูเคสที่รับวันนี้ทั้งหมด แยกตามเจ้าของเคส — ไม่ต้อง /activate\n" +
          "• /status → ดูคิวถัดไปและเคสล่าสุด — ไม่ต้อง /activate\n" +
          "• /undo → ลบเคสล่าสุด (เผื่อลงผิด) และคืนคิวกลับ — ไม่ต้อง /activate\n" +
          "• /setnext ตามด้วยชื่อ เช่น '/setnext peem' → ตั้งคิวถัดไปเอง (สำหรับรีเซ็ตคิวตอนเปลี่ยนรอบเวร) — ไม่ต้อง /activate\n\n" +
          `รอบเวรตอนนี้: ${ORDER.join(" → ")} → (วนซ้ำ)`
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

  if (text === "/allcase" || text === "/summary") {
    const message = await buildActiveCaseMessage();
    return reply(event.replyToken, [textMessage(message)]);
  }

  if (text === "/todaycase") {
    const message = await buildTodayCaseMessage();
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

  if (text === "/announce") {
    return reply(event.replyToken, [textMessage(ANNOUNCEMENT_MESSAGE)]);
  }

  // ---- Admin: manually set the queue pointer, e.g. "/setnext jennie" ----
  // Needed whenever ORDER changes (new rotation, people added/removed) —
  // the stored pointer index means nothing under a different-length or
  // reordered ORDER array, so this lets you explicitly re-anchor it.
  if (text.toLowerCase().startsWith("/setnext")) {
    const parts = text.split(/\s+/);
    const nameArg = parts[1];
    if (!nameArg) {
      return reply(event.replyToken, [
        textMessage(`พิมพ์ /setnext ตามด้วยชื่อ เช่น /setnext ${ORDER[0].toLowerCase()}`),
      ]);
    }
    const idx = ORDER.findIndex((n) => n.toLowerCase() === nameArg.toLowerCase());
    if (idx === -1) {
      return reply(event.replyToken, [
        textMessage(`ไม่พบชื่อ "${nameArg}" ในคิว (${ORDER.join(", ")})`),
      ]);
    }
    await setNextIndex(idx);
    return reply(event.replyToken, [
      textMessage(`ตั้งคิวถัดไปเป็น: ${ORDER[idx]} แล้วครับ`),
    ]);
  }

  // ---- Everything below requires /activate immediately beforehand ----
  // (see comment above activatedSources for why).
  if (!isActivated) return;

  // ---- Discharge: "3 มาโนชญ d/c" (name required) ----
  // Checked before case detection since "d/c" would otherwise look like
  // a (nonsensical) patient name. Discharging never touches the queue.
  // Name is required and matched exactly, since bed numbers get reused —
  // this prevents accidentally discharging the wrong patient.
  const dischargeRequests = detectDischarges(text);
  if (dischargeRequests.length > 0) {
    const lines = [];
    for (const req of dischargeRequests) {
      const result = await sheets.dischargeCase(req.bedNumber, req.patientName);
      if (result.removed) {
        lines.push(
          `✅ จำหน่ายเตียง ${req.bedNumber} (${result.removed.patientName}) แล้ว — ${result.removed.assignedTo} เหลือเคส Active ${result.remainingActiveForOwner} เคส`
        );
      } else if (result.activeNameAtBed) {
        lines.push(
          `⚠️ เตียง ${req.bedNumber} ที่ Active อยู่ตอนนี้คือ "${result.activeNameAtBed}" ไม่ตรงกับ "${req.patientName}" ที่พิมพ์มา กรุณาตรวจสอบชื่ออีกครั้ง`
        );
      } else {
        lines.push(`⚠️ ไม่พบเตียง ${req.bedNumber} ที่ยัง Active อยู่`);
      }
    }
    return reply(event.replyToken, [textMessage(lines.join("\n"))]);
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
// showStatus adds a "(จำหน่ายแล้ว)" tag for discharged cases — used by
// /todaycase, which lists today's cases regardless of discharge status.
function groupCasesByOwner(cases, { showStatus = false } = {}) {
  const byPerson = {};
  for (const c of cases) {
    byPerson[c.assignedTo] = byPerson[c.assignedTo] || [];
    const suffix = showStatus && c.status === "Discharged" ? " (จำหน่ายแล้ว)" : "";
    byPerson[c.assignedTo].push(`เตียง ${c.bedNumber} ${c.patientName}${suffix}`);
  }
  return Object.entries(byPerson).map(
    ([person, items]) => `${person} (${items.length}):\n  ${items.join("\n  ")}`
  );
}

async function queueFooterLine() {
  const nextIndex = await getNextIndex();
  return `คิวถัดไป: ${ORDER[nextIndex]}`;
}

// All currently-active (non-discharged) cases, grouped by owner —
// used by /allcase, /summary (now identical), and the 6 AM auto-message.
async function buildActiveCaseMessage() {
  const active = await sheets.getActiveCases();
  const footer = await queueFooterLine();
  if (active.length === 0) {
    return `ไม่มีเคส Active ในตอนนี้ครับ\n\n${footer}`;
  }
  const sorted = [...active].sort(
    (a, b) => parseInt(a.bedNumber, 10) - parseInt(b.bedNumber, 10)
  );
  const lines = groupCasesByOwner(sorted);
  return `เคส Active ทั้งหมด (${active.length}):\n\n${lines.join("\n\n")}\n\n${footer}`;
}

// Returns a Sheet-timestamp's calendar date in Bangkok time as YYYY-MM-DD,
// so "today" always means the ward's local day, not the server's UTC day.
// Returns null for missing/invalid timestamps instead of throwing — a
// manually-edited Sheet row with a blank or malformed date used to crash
// Intl.DateTimeFormat here, which silently killed the whole /todaycase
// reply (the error was caught far upstream in the webhook handler and
// just logged, so the bot looked like it did nothing at all).
function bangkokDateString(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// All cases admitted today (Bangkok time), grouped by owner — regardless
// of whether they've since been discharged, since this is an admissions
// log for the day, not an active-census view.
async function buildTodayCaseMessage() {
  const all = await sheets.getAllCases();
  const footer = await queueFooterLine();
  const todayStr = bangkokDateString(new Date());
  const todayCases = all.filter(
    (c) => bangkokDateString(new Date(c.timestamp)) === todayStr
  );
  if (todayCases.length === 0) {
    return `ยังไม่มีเคสที่รับวันนี้ครับ\n\n${footer}`;
  }
  const sorted = [...todayCases].sort(
    (a, b) => parseInt(a.bedNumber, 10) - parseInt(b.bedNumber, 10)
  );
  const lines = groupCasesByOwner(sorted, { showStatus: true });
  return `เคสวันนี้ทั้งหมด (${todayCases.length}):\n\n${lines.join("\n\n")}\n\n${footer}`;
}

// ---- Daily automatic message, 6:00 AM Bangkok time ----
// Sends the active-case breakdown (same as /allcase) so the morning
// message shows exactly who owns what right now.
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

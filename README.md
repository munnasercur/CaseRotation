# KhunThong-lite

A tiny LINE bot for your ICU rotation group. It watches the group chat, notices
new-case messages like `3 มาโนชญ` (bed number + patient name), and
auto-assigns them round-robin: **Munna → Jennie → Peem → repeat**.

It uses a Google Sheet as its database — one tab logs every case, another
tiny tab stores the group's chat ID so it can send the daily summary.

---

## What you'll set up (all free tiers)

1. A LINE Messaging API channel (the bot itself)
2. A Google Cloud service account (so the bot can write to a Sheet)
3. A Google Sheet (the database)
4. A hosting service to run this code 24/7 (Render.com recommended)

Budget ~30-45 minutes the first time.

---

## 1. Create the LINE bot

1. Go to https://developers.line.biz/console/ and log in with your LINE account.
2. Create a **Provider** (any name, e.g. "ICU Rotation").
3. Inside it, create a new **Messaging API** channel.
   - Channel name: e.g. "KhunThong Lite"
   - Category/subcategory: anything reasonable (e.g. Education)
4. In the channel's **Messaging API** tab:
   - Scroll to **Channel access token** → click **Issue** → copy it. This is `LINE_CHANNEL_ACCESS_TOKEN`.
   - Copy the **Channel secret** from the **Basic settings** tab. This is `LINE_CHANNEL_SECRET`.
   - Turn **off** "Auto-reply messages" and "Greeting messages" (under LINE Official Account Manager settings, linked from this page) so the bot doesn't send LINE's default replies.
   - Turn **on** "Use webhook".
   - Leave the Webhook URL blank for now — you'll add it after deploying in step 4.

Keep this tab open; you'll come back to paste the webhook URL.

---

## 2. Create the Google Sheet (the database)

1. Create a new Google Sheet.
2. Rename the first tab to exactly `Log`. Add headers in row 1:
   `Timestamp | BedNumber | PatientName | AssignedTo | RawText`
3. Add a second tab named exactly `Config`. Add headers in row 1:
   `Key | Value`
4. Copy the Sheet's ID from the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART_IS_THE_ID`**`/edit`
   This is `GOOGLE_SHEET_ID`.

---

## 3. Create a Google service account (so the bot can write to the Sheet)

1. Go to https://console.cloud.google.com/ → create a new project (or reuse one).
2. Enable the **Google Sheets API** for that project (search it in the top search bar → Enable).
3. Go to **IAM & Admin → Service Accounts → Create Service Account**.
   - Any name is fine, e.g. `khunthong-bot`.
   - No special roles needed — skip that step.
4. Click into the new service account → **Keys** tab → **Add Key → Create new key → JSON**. This downloads a `.json` file.
5. Open that JSON file. You need two values from it:
   - `client_email` → this is `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → this is `GOOGLE_PRIVATE_KEY` (a long string starting with `-----BEGIN PRIVATE KEY-----`)
6. **Share your Google Sheet** with that `client_email` address, giving it **Editor** access (same as sharing with a person).

---

## 4. Deploy the bot (Render.com, free tier)

1. Push this project folder to a GitHub repo (or use Render's "Upload" option).
2. On https://render.com → **New → Web Service** → connect your repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Under **Environment**, add these variables:

   | Key | Value |
   |---|---|
   | `LINE_CHANNEL_ACCESS_TOKEN` | from step 1 |
   | `LINE_CHANNEL_SECRET` | from step 1 |
   | `GOOGLE_SHEET_ID` | from step 2 |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | from step 3 |
   | `GOOGLE_PRIVATE_KEY` | from step 3 — paste it with `\n` where line breaks are (the code converts these back automatically) |

4. Deploy. Once live, Render gives you a URL like `https://khunthong-lite.onrender.com`.
5. Go back to the LINE Developers console (step 1) and set the **Webhook URL** to:
   `https://khunthong-lite.onrender.com/webhook`
   Click **Verify** — it should succeed.

> Note: Render's free tier sleeps after inactivity, causing a ~30s delay on
> the first message after a quiet period. Fine for a rotation group; if it
> bothers you, Render's cheapest paid tier keeps it always-on.

---

## 5. Add the bot to your group

1. In the LINE Developers console, go to the channel's **Messaging API** tab and scan the QR code / add the bot as a friend.
2. Invite it into your `เมด 2b(3)` group chat like any other member.
3. It'll greet the group and explain itself.

---

## How it works day-to-day

- Type a message like `3 มาโนชญ` → bot replies assigning it to whoever's turn it is, and tells you who's next.
- `/status` — see whose turn is next and the last 3 cases.
- `/undo` — remove the most recently logged case (in case the bot misread a normal message as a case).
- `/summary` — see today's case counts per person, on demand.
- Every morning at **8:00 AM (Bangkok time)**, the bot automatically posts the last-24-hours summary to the group.

## Tuning the detection pattern

If the bot ever misses real cases or catches false positives, the pattern
lives in `lib/caseDetector.js`. Currently it matches: 1–3 digits, optional
space, then a name made of Thai/English letters (no digits or punctuation
after) — this is what distinguishes `3 มาโนชญ` from things like `6:44` or a
phone number.

## Changing the rotation order or adding people

Edit the `ORDER` array in `lib/rotation.js`.

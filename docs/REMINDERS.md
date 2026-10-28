# Optional email and SMS reminders

Karen's Load keeps patient names, notes, evidence, and task titles in the browser on this laptop. The local reminder service receives **only active-case counts and deadline dates**. Messages contain counts and a date window, with no patient names or task titles. Recipient addresses, deadlines, and reminder preferences are stored in `.local/reminders.json`; keep the project folder on a private Windows account. This file is not encrypted.

## Start the app

Install Node.js 22.13 or newer, then double-click `Start Karens Load.cmd`, or run `npm start` in this folder. Use **http://127.0.0.1:47831** consistently in the same browser profile. No npm install is needed. Keep the command window open for background reminders; the browser tab can be closed after changes are saved. The launcher opens your browser after the local server is ready.

The default port is 47831. An advanced `KARENS_LOAD_PORT` setting is supported in `.env` if that port is unavailable, but keep the chosen address stable: changing a browser origin creates separate browser storage. Export a case backup first and restore it at the new address.

## Connect email

1. Create a [Resend account](https://resend.com), configure a sender allowed by your account, and create an API key. Production sending generally requires a verified sender domain; account testing restrictions may apply.
2. Copy `.env.example` to `.env` in this folder.
3. Set `RESEND_API_KEY` and `REMINDER_EMAIL_FROM` (for example, `Karen's Load <reminders@your-verified-domain.example>`).
4. Restart Karen's Load. In **Reminders**, choose Email, enter the recipient, set the deadline window and daily time, and save. Use **Send test reminder** to verify the connection.

Provider reference: [Resend Send Email](https://resend.com/docs/api-reference/emails/send-email). API keys stay in the local `.env` file and never appear in the browser or case backups.

## Connect SMS

1. Create a [Twilio account](https://www.twilio.com), obtain an SMS-capable sending number, and complete the sender/recipient requirements for your country and account. Trial accounts may restrict recipients; provider fees apply.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` in `.env`. Use an international number such as `+15551234567`.
3. Restart Karen's Load. In **Reminders**, choose SMS and enter the recipient in international format. Save, then send a test.

Provider reference: [Twilio Messages resource](https://www.twilio.com/docs/messaging/api/message-resource).

## How the schedule works

The local service checks once a minute and sends one daily digest after the selected time in **Pacific Time (`America/Los_Angeles`)**, regardless of the laptop's own time zone. PST/PDT daylight-saving changes are handled automatically. A window of 3 days includes today and the following three calendar days. The overdue option also includes earlier unfinished work. Completed cases and completed tasks are excluded. Case deadlines and task deadlines are counted separately. No digest is sent when nothing matches.

Reminders use the latest deadline snapshot saved by this browser. Changes must be saved while the local server is running. The Reminders screen shows the last synchronization time. Restoring a backup, finishing a task, and changing a timeline update the snapshot when the app is open. Browser data in another profile or at another origin is separate.

The laptop must be awake and connected when a message is sent. If it is asleep at the selected time, the service checks when it resumes. Shutting down the local server stops reminder checks. For reminders while the laptop is off, a future cloud service is required.

Successful provider acceptance is recorded once per day per channel, including across server restarts. This means the provider accepted the message; it does not prove delivery. Check the provider dashboard for delivery status. Email failures can retry after 15 minutes using Resend idempotency keys. SMS attempts are recorded before sending and never retried automatically that day, because a timeout may still have delivered the message. Use the test button for a deliberate retry after checking the provider dashboard; it can send additional messages and incur charges.

## Optional: check with Windows Task Scheduler

No Windows scheduled task is installed automatically. If you want checks while the app server is closed, create a task yourself:

- Run as your Windows account, only when logged on.
- Trigger daily at or after the reminder time you chose in the app.
- Program: the full path to `node.exe` (find it with `where node`).
- Arguments: `"F:\Projects\karen-scrum\reminder-service.mjs" --reminders-once` (adjust the folder if you move the project).
- Start in: `F:\Projects\karen-scrum`.
- Enable “Run task as soon as possible after a scheduled start is missed.”

The one-shot command respects the saved enabled setting, time, deadline window, and daily deduplication. It uses the most recent saved snapshot. It cannot run while the laptop is powered off and does not read patient records from the browser.

## Turn reminders off

Disable reminders in the app and save. Remove any Windows task you created. Delete `.env` if you no longer need provider credentials. A backup of case records is separate from the `.env` provider secrets and local delivery history.

# Karen's Load

[Open the Hosted Trial](https://karenshugeload.com/) on a laptop or phone. The [GitHub Pages Link](https://praujekt.github.io/karen-scrum/) redirects to the same site. It starts with six editable fictional patients; no installation is needed to try the website.

A personal case and assessment planner for Karen, with a responsive laptop/phone interface. It works locally or on a static host such as GitHub Pages. An optional encrypted shared workspace connects her devices; a separate cloud scheduler can send reminders while the laptop is off. All project work lives in this directory.

The initial trial uses fictional records and local browser storage. **Shared storage, Google sign-in, and real email/SMS delivery need their account settings and backend deployment before activation.** No real patient data or provider credentials are included in this repository.

## Start the App

1. Install Node.js 22.13 or newer if it is not already installed.
2. Double-click **Start Karens Load.cmd**. It opens the app after the local server is ready.
3. Keep using **http://127.0.0.1:47831** in the same browser.

Alternatively, run `node server.mjs` in this directory and open that address. No `npm install` is required to use the app. Internet access is unnecessary for local case tracking; shared writes and sending reminders require a connection. See [Hosting Instructions](docs/HOSTING.md) for GitHub Pages or another HTTPS static host. Phones can open the hosted site without installing Node.

The first launch includes **six clearly marked fictional patients**, two in each state: **Not Started**, **In Progress**, and **Completed**. They demonstrate overdue and approaching deadlines, activities spanning Weeks 1–5 and Weeks 2–4, reports not yet written, a written report awaiting submission, a submitted report, notes, and paper/Drive/uploaded evidence. Existing fictional examples are upgraded without replacing real cases or templates. **Refresh Examples** resets only the fictional demo; **Remove Examples** removes them while keeping patients you added. Examples do not enter email or SMS reminders. Removing examples or clearing the workspace is remembered; the app does not recreate them on the next launch.

## Everyday Use

- **Overview** is a deadline workspace. It defaults to the next seven days, includes overdue activities, and groups unfinished work by its due date and patient. Use **View Through** or the 7/14/30-day presets to change the cutoff. Red and amber accents make overdue and approaching work stand out. A separate **Written, Not Submitted** queue includes ready work even beyond the selected date, with **Mark Submitted** to record completion. Final **Case Deadlines** stay visible even when all activities are checked off.
- **All Cases** lists every patient and retains the caseload metrics. Its **Not Started**, **In Progress**, and **Completed** folders provide direct status views without changing the records. **Coming Up** retains its existing seven-day agenda.
- Business dates and reminder send times use **Pacific Time**, with automatic PST/PDT daylight-saving changes, even if a device uses another time zone.
- **New Case** lets you choose a reusable activity plan from the **Template Library**. The included assessment plan contains the supplied 19 activities across five weeks. Conditional activities are labeled **If Needed**. They remain in progress totals and due lists until completed or removed; remove any that do not apply from the case without changing its template.
- The **Final Due Date** anchors the plan backward: December 31 gives weekly target dates December 3, 10, 17, 24, and 31. The planned start is November 27, regardless of when the case was opened. Shorter runways show a review notice instead of silently changing deadlines.
- Check off activities, change individual dates, add/remove activities, or edit the case name and final deadline. Changing the final deadline can shift all activity dates while retaining custom spacing.
- Activities default to **one week and one completion checkbox**. In template activities or **Edit Activity** on an existing case, optionally enable **Spans Multiple Weeks** and choose **Start Week** / **End Week**. The activity appears with a **Starting Week** prefix in its starting week and an **Ending Week** prefix in its ending week, in both cases and templates. Completion controls appear at Ending Week. Both entries refer to one activity, so progress and reminder counts stay accurate. Default due dates and weekly completion totals use the ending week. Starting Week uses the end of its planned starting week for amber/red timing cues (or an earlier custom final deadline); **Start Week Passed** distinguishes that window from an overdue final deadline. Marking Written clears a passed-start warning; final deadline warnings remain. Completing the activity or case clears both entries' urgency.
- Optionally enable **Track Written and Submitted Separately** for an activity. The two labeled checkboxes sit in a compact column to the left of the activity title, aligned with ordinary checkboxes. **Written** starts progress but does not complete the activity; **Submitted** is the final completion step. Marking Submitted also marks Written; clearing Written reopens the activity. Ordinary activities keep their single checkbox. Case changes never modify the saved template.
- **Status** supports **Not Started**, **In Progress**, and **Completed**. Checking the first activity starts progress. Completion is an explicit choice; unfinished optional activities do not prevent closing a case.
- **Notes** can be added, edited, and deleted. **Evidence** supports paper document locations, Google Drive/Docs links, other website links, uploaded scans/photos/files, and local file references. Browser restrictions mean a local reference offers **Copy Path** for File Explorer. References do not copy the original file or change a Google document's access permissions.
- **Edit Case** edits patient names and dates. **Delete Case** removes the patient, notes, and uploaded copies after confirmation.
- **Template Library** keeps reusable activity plans for future cases. Choose a template when creating a case; later template changes do not alter existing cases or their customized plans.
- **Print Plan** prints the currently displayed case information.

## Storage and Backups

By default, case records and uploaded evidence are stored in IndexedDB in this browser on this device. The small local server serves application files and optionally sends reminders; it does not keep patient names, notes, or uploaded evidence. One workspace tab can edit at a time to prevent conflicting saves.

Use **Download Backup** regularly. The portable JSON backup includes cases, notes, template settings, and the bytes of uploaded evidence. Restore validates the entire backup before atomically replacing the workspace. Local reminder settings and provider credentials are separate; restore disables reminders until you re-enable them.

Uploads are limited to 25 MB each and 100 MB total across the workspace so a full backup stays portable. Large original documents can be referenced by path instead. Changing browsers, clearing browser storage, changing the address/port, or moving to a different computer does not carry records with it: use backup and restore. Copying this source folder alone does not copy patient records.

Local browser records and downloaded backup files are not encrypted by this app. Shared workspace data is encrypted in the browser before cloud upload. Use an approved, access-controlled device and storage location for patient information; this project does not claim compliance with workplace or clinical record requirements.

## The Same Cases on Phone and Laptop

The optional [Cloud Backend](cloud-reminders/README.md) supplies shared storage and the independent reminder scheduler. GitHub Pages continues to serve the interface; patient records never belong in the public repository or Pages artifacts.

After deploying the backend, connect each device to the same workspace and use the same encryption passphrase. Google sign-in can restrict access to her verified Google account; an administrator connection key is also supported. Google setup requires a web OAuth client with the hosted origin allowed, and the backend must be configured with that client ID and her allowed account. Signing in does not grant access to Google Drive files; existing Drive documents remain ordinary permission-controlled links.

Case records, notes, template settings, evidence names/links, and uploaded file contents are encrypted before upload. The encryption passphrase stays in memory and must be entered to unlock a saved connection after reopening. Keep a separate verified backup and remember the passphrase; Google sign-in does not recover a lost encryption passphrase. Provider credentials remain on the backend; connection credentials are excluded from case backups.

Shared writes require an online connection. The app refreshes before a shared change, checks versions, and rejects conflicting writes instead of silently overwriting another device. A failed save keeps the previous cached version and requires a refresh before retrying. Local-only mode remains available for the demo and for use on one device.

## Email and SMS Reminders

See [Reminder Setup](docs/REMINDERS.md). Email uses Resend; SMS uses Twilio. Provider accounts and local credentials are needed before sending. Reminders are off initially, and no message is sent by the example workspace or test suite.

The settings screen lets her choose the delivery channel, recipient, daily time, days before deadlines, and whether to include overdue work. Reminder send times use **Pacific Time**, with automatic PST/PDT changes, regardless of a device's location. A digest contains only counts and deadline dates, without patient names, activity titles, notes, or evidence. **Send Test Reminder** requires an explicit click and confirmation.

For the local reminder option, keep the local service running; the browser may be closed, but the laptop must be awake and connected. An optional Windows Task Scheduler setup is documented. For reminders with the laptop off, deploy and connect the cloud service described above. It runs on its own schedule after the latest dates have synchronized. Only counts, dates, delivery addresses, and reminder preferences are readable by that scheduler; patient records remain encrypted.

## Development and Verification

```text
npm test
```

Native Node tests check dates, imported data, reminder scheduling/deduplication, and local API boundaries. Browser tests use an optional Playwright library and system Chrome; without it they are reported as skipped. To run those checks too:

```text
npm install --prefix .qa-tools --no-package-lock playwright
npm test
```

Set `KARENS_LOAD_BROWSER_EXECUTABLE` if using a different Chromium executable. Browser tests use isolated contexts, fake patients, temporary reminder files, and mocked providers; they do not touch real records or send messages.

`dist/model.js` owns template/date logic, `dist/data.js` provides local storage, `dist/workspace-sync.js` handles encrypted shared records, and `dist/app.js` implements the interface. `server.mjs` serves files on loopback only; `reminder-service.mjs` owns local reminder delivery. The standalone Cloudflare Worker is in `cloud-reminders/`. Google Identity Services loads only when Google sign-in is explicitly chosen; ordinary tracking loads no external scripts, analytics, fonts, or network assets.

The browser and backend tests cover fake records, encrypted two-device round trips, file integrity, version conflicts, allowed-account verification, deadline scheduling, and provider request behavior. Deployed Google sign-in and actual email/SMS delivery require account configuration and live verification; automated tests use mocks.

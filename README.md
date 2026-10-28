# Weekwise

A personal case and assessment planner for Karen, with a responsive laptop/phone interface. It works locally or on a static host such as GitHub Pages. An optional encrypted shared workspace connects her devices; a separate cloud scheduler can send reminders while the laptop is off. All project work lives in this directory.

The initial trial uses fictional records and local browser storage. **Shared storage, Google sign-in, and real email/SMS delivery need their account settings and backend deployment before activation.** No real patient data or provider credentials are included in this repository.

## Start the app

1. Install Node.js 22.13 or newer if it is not already installed.
2. Double-click **Start Weekwise.cmd**. It opens the app after the local server is ready.
3. Keep using **http://127.0.0.1:47831** in the same browser.

Alternatively, run `node server.mjs` in this directory and open that address. No `npm install` is required to use the app. Internet access is unnecessary for local case tracking; shared writes and sending reminders require a connection. See [hosting instructions](docs/HOSTING.md) for GitHub Pages or another HTTPS static host. Phones can open the hosted site without installing Node.

The first launch includes **six clearly marked fictional patients**, two in each state: pending, in progress, and completed. They have different deadlines, checked activities, notes, sample evidence files, and a sample local document reference. Use **Remove examples** to remove those cases while keeping any patients you added yourself. Examples do not enter email or SMS reminders. Removing examples or clearing the workspace is remembered; the app does not recreate them on the next launch.

## Everyday use

- **Overview** shows open cases, cases due within seven days or overdue, pending cases, and all completed cases. Open means pending plus in progress. Click a metric to filter the list.
- **New case** starts with the supplied 19-activity, five-week template. Activities marked “if necessary” are labeled optional and can be removed when unnecessary.
- The **final due date** anchors the plan backward: December 31 gives weekly target dates December 3, 10, 17, 24, and 31. The planned start is November 27, regardless of when the case was opened. Shorter runways show a review notice instead of silently changing deadlines.
- Check off activities, change individual dates, add/remove activities, or edit the case name and final deadline. Changing the final deadline can shift all activity dates while retaining custom spacing.
- **Status** supports Open / pending, In progress, and Completed. Checking the first activity starts progress. Completion is an explicit choice; unfinished optional activities do not prevent closing a case.
- **Notes** can be added, edited, and deleted. **Evidence** supports paper document locations, Google Drive/Docs links, other website links, uploaded scans/photos/files, and local file references. Browser restrictions mean a local reference offers **Copy path** for File Explorer. References do not copy the original file or change a Google document's access permissions.
- **Edit case** edits patient names and dates. **Delete case** removes the patient, notes, and uploaded copies after confirmation.
- **Activity template** changes the starting plan for future cases. Existing cases keep their own plans.
- **Print plan** prints the currently displayed case information.

## Storage and backups

By default, case records and uploaded evidence are stored in IndexedDB in this browser on this device. The small local server serves application files and optionally sends reminders; it does not keep patient names, notes, or uploaded evidence. One workspace tab can edit at a time to prevent conflicting saves.

Use **Download backup** regularly. The portable JSON backup includes cases, notes, the custom template, and the bytes of uploaded evidence. Restore validates the entire backup before atomically replacing the workspace. Local reminder settings and provider credentials are separate; restore disables reminders until you re-enable them.

Uploads are limited to 25 MB each and 100 MB total across the workspace so a full backup stays portable. Large original documents can be referenced by path instead. Changing browsers, clearing browser storage, changing the address/port, or moving to a different computer does not carry records with it: use backup and restore. Copying this source folder alone does not copy patient records.

Local browser records and downloaded backup files are not encrypted by this app. Shared workspace data is encrypted in the browser before cloud upload. Use an approved, access-controlled device and storage location for patient information; this project does not claim compliance with workplace or clinical record requirements.

## The same cases on phone and laptop

The optional [cloud backend](cloud-reminders/README.md) supplies shared storage and the independent reminder scheduler. GitHub Pages continues to serve the interface; patient records never belong in the public repository or Pages artifacts.

After deploying the backend, connect each device to the same workspace and use the same encryption passphrase. Google sign-in can restrict access to her verified Google account; an administrator connection key is also supported. Google setup requires a web OAuth client with the hosted origin allowed, and the backend must be configured with that client ID and her allowed account. Signing in does not grant access to Google Drive files; existing Drive documents remain ordinary permission-controlled links.

Case records, notes, template settings, evidence names/links, and uploaded file contents are encrypted before upload. The encryption passphrase stays in memory and must be entered to unlock a saved connection after reopening. Keep a separate verified backup and remember the passphrase; Google sign-in does not recover a lost encryption passphrase. Provider credentials remain on the backend; connection credentials are excluded from case backups.

Shared writes require an online connection. The app refreshes before a shared change, checks versions, and rejects conflicting writes instead of silently overwriting another device. A failed save keeps the previous cached version and requires a refresh before retrying. Local-only mode remains available for the demo and for use on one device.

## Email and SMS reminders

See [reminder setup](docs/REMINDERS.md). Email uses Resend; SMS uses Twilio. Provider accounts and local credentials are needed before sending. Reminders are off initially, and no message is sent by the example workspace or test suite.

The settings screen lets her choose the delivery channel, recipient, daily time, days before deadlines, and whether to include overdue work. A digest contains only counts and deadline dates, without patient names, activity titles, notes, or evidence. **Send test reminder** requires an explicit click and confirmation.

For the local reminder option, keep the local service running; the browser may be closed, but the laptop must be awake and connected. An optional Windows Task Scheduler setup is documented. For reminders with the laptop off, deploy and connect the cloud service described above. It runs on its own schedule after the latest dates have synchronized. Only counts, dates, delivery addresses, and reminder preferences are readable by that scheduler; patient records remain encrypted.

## Development and verification

```text
npm test
```

Native Node tests check dates, imported data, reminder scheduling/deduplication, and local API boundaries. Browser tests use an optional Playwright library and system Chrome; without it they are reported as skipped. To run those checks too:

```text
npm install --prefix .qa-tools --no-package-lock playwright
npm test
```

Set `WEEKWISE_BROWSER_EXECUTABLE` if using a different Chromium executable. Browser tests use isolated contexts, fake patients, temporary reminder files, and mocked providers; they do not touch real records or send messages.

`dist/model.js` owns template/date logic, `dist/data.js` provides local storage, `dist/workspace-sync.js` handles encrypted shared records, and `dist/app.js` implements the interface. `server.mjs` serves files on loopback only; `reminder-service.mjs` owns local reminder delivery. The standalone Cloudflare Worker is in `cloud-reminders/`. Google Identity Services loads only when Google sign-in is explicitly chosen; ordinary tracking loads no external scripts, analytics, fonts, or network assets.

The browser and backend tests cover fake records, encrypted two-device round trips, file integrity, version conflicts, allowed-account verification, deadline scheduling, and provider request behavior. Deployed Google sign-in and actual email/SMS delivery require account configuration and live verification; automated tests use mocks.

# Encrypted workspace sync

Workspace sync is optional. With no connection, Weekwise keeps cases and evidence only in the current browser. With a configured workspace service, the laptop and phone can open the same cases, notes, checklist marks, and uploaded evidence.

## Connect each device

Deploy and configure the separate worker using [cloud-reminders/README.md](../cloud-reminders/README.md). It needs an HTTPS URL, the exact allowed frontend origin, storage bindings, and either a long connection key or the Google sign-in configuration. Publishing the frontend on GitHub Pages does not deploy or activate that worker.

In Weekwise settings, enter that service URL and either the connection key or sign in with the configured Google account. Choose an encryption passphrase of at least 12 characters. Use the **same service and encryption passphrase on both devices**. The first connection to an empty cloud workspace uploads the current local workspace. Connecting to an existing cloud workspace replaces that device's local cached workspace with the shared records; download a local backup first if it contains work you want to keep.

Google sign-in authorizes access to the service. The encryption passphrase is still needed to decrypt the records. The service cannot recover a forgotten passphrase. Keep it somewhere safe, and retain a verified backup independently.

The encryption key stays in memory. After reloading or opening a new session, unlock the workspace again. A key-based connection token is saved in this browser's local storage; a Google ID token is saved only in session storage and may require another Google sign-in when it expires. These connection credentials and the passphrase are excluded from Weekwise backup files.

## Editing and conflicts

Connected edits refresh the shared copy first and save a new cloud version afterward. A second device's newer version cannot be silently overwritten. If two devices save concurrently, the losing device restores its previous local state, explains the conflict, and requires an explicit refresh before another edit. Refresh displays the saved shared version so the user can apply the change again.

In connected mode, offline access provides the cached records for reading. Writes require an online, unlocked connection. This avoids silently accumulating competing changes on different devices. A network interruption after sending a save can leave its outcome unconfirmed; refresh before editing again to see the server's version.

Disconnecting keeps the local cached records and forgets this browser's service connection. It does not delete the cloud workspace. Clearing browser storage removes the local cache and saved connection, so reconnect and unlock to retrieve shared records.

## Evidence and backups

Uploaded files are encrypted and shared along with the case. Google Drive evidence remains a document link; sign in to Google Drive separately to open it. A local file path refers to the originating laptop, so it may not work on the phone. A paper evidence entry records where the physical document is kept.

Use downloaded backups as a separate recovery copy. Backups include uploaded evidence and **are not encrypted**; store them in an approved location. Connection credentials are excluded. Restoring while connected replaces the shared workspace after the app's confirmation, so both devices will see the restored records after refreshing.

Each file may be up to 25 MB and active local evidence totals up to 100 MB. Encrypted metadata, including cases, notes, and template settings, is limited to 7 MB. The current worker also reserves storage for immutable encrypted uploads, including previous or orphaned files; deleting a case does not automatically reclaim that remote allocation. Its README describes this trial limitation and owner-controlled recovery options.

## Implementation

`dist/workspace-sync.js` uses browser WebCrypto: PBKDF2-HMAC-SHA-512 with 210,000 iterations and a random 16-byte salt derives a non-extractable AES-256-GCM key. The workspace salt remains stable; every metadata save and new file uses a fresh random 12-byte IV. Metadata uses an authenticated version tag, and file authentication binds its local and remote identifiers. Files are uploaded under immutable random UUIDs before the version-checked metadata save. The worker receives encrypted patient records and file bytes. The same accepted save commits unencrypted reminder counts and dates, excluding patient names, notes, activity titles, and evidence locations. This keeps reminder dates current when either connected device changes a case, without a separate reminder connection on that device.

The worker is still trusted to enforce access, preserve encrypted versions, and serve the frontend's configured origin. Browser caches and downloaded backups contain readable patient records. Encryption does not turn an unapproved device, host, or workplace workflow into an approved one.

The optional real-browser check `node --test tests/workspace-sync.browser.test.mjs` uses isolated browser profiles and a mocked backend. It verifies sharing, file encryption, passphrase handling, offline writes, version conflicts, rollback, Google session-token storage, and ciphertext damage. It does not verify a live Cloudflare account or deployment.

`node --test tests/workspace-integration.browser.test.mjs` additionally runs the browser client against the shipped Worker source with local SQLite and R2 adapters, including version-bound reminder snapshots. It still does not contact a live Cloudflare account.

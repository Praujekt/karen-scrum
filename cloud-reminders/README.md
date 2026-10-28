# Cloud sync and always-on reminders

This optional Cloudflare Worker gives the static Karen's Load frontend an encrypted shared workspace and a reminder scheduler that keeps running when the laptop is off. It is **deploy-ready source, not an activated service**. Deployment needs your Cloudflare account; Google sign-in and email/SMS each need their own setup. No cloud resources or messages are created by opening the local project.

## What is stored

- Case records, notes, settings, document references, and uploaded evidence are encrypted in the browser before workspace synchronization. The Worker stores opaque encrypted envelopes/files in a private R2 bucket. It never receives the encryption password or decryption key. D1 stores the workspace version, ciphertext object locations, file hashes/sizes, and upload reservations.
- Deadline reminders are separate. Their scheduler needs the recipient email/phone, reminder preferences, active-case counts, deadline dates, and time zone in readable form. Patient names, case notes, task titles, and evidence are not included in this reminder metadata or in messages.
- Google identity is verified by the Worker and restricted to one configured account. A long sync token is also supported as an administrator/fallback credential. Authentication permits access to ciphertext; the separate workspace passphrase is needed to decrypt it. Losing that passphrase prevents recovery through this service, so retain a secure backup.

Provider usage charges, account restrictions, and storage limits can apply. This implementation does not make a regulatory compliance claim; use the organization's approved devices and data handling practices for real patient records.

## 1. Create Cloudflare storage

Run these commands from `cloud-reminders/` using a current Node.js installation. Wrangler is a deployment tool; the deployed Worker has no npm runtime dependencies.

```powershell
npx wrangler login
npx wrangler d1 create karens-load
npx wrangler r2 bucket create karens-load-encrypted-files
```

Copy the returned D1 database ID into `wrangler.jsonc` as `database_id`; keep its binding name `DB`. Keep the R2 binding name `FILES` and set its `bucket_name` to the private bucket you created. Do not enable public bucket access.

Set `ALLOWED_ORIGIN` in `wrangler.jsonc` to the frontend's **exact origin**. This project now uses `https://karenshugeload.com`; keep that value when activating the service. The GitHub Pages address redirects there. For another deployment without a custom domain, the origin could be `https://YOUR-USERNAME.github.io`, with no repository path or trailing slash. For local development it is `http://127.0.0.1:47831`. One origin is allowed; wildcards are rejected. Both devices should use the canonical domain.

Create or upgrade the database tables:

```powershell
npx wrangler d1 execute karens-load --remote --file=schema.sql
```

The schema is safe to apply again and does not reset existing records. Source: [Cloudflare D1 API](https://developers.cloudflare.com/d1/worker-api/), [R2 bucket creation](https://developers.cloudflare.com/r2/buckets/create-buckets/). Encrypted metadata is stored in R2 because [D1 limits each string/row to 2 MB](https://developers.cloudflare.com/d1/platform/limits/).

## 2. Configure Google sign-in

Follow [Google Identity Services setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid) to create a **Web application** OAuth client. Add `https://karenshugeload.com` to its authorized JavaScript origins. Configure the Google consent screen and any test-user settings needed by your Google project. A Google OAuth client secret is not used by this browser ID-token flow.

Save the public client ID and the exact allowed user's email in Worker configuration through Wrangler prompts:

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put ALLOWED_GOOGLE_EMAIL
```

Use the same client ID in the frontend's Google connection settings. Only the configured, verified Google account is allowed. The Worker validates Google's signing keys/signature, audience, issuer, expiry, and verified email; it does not trust an unverified browser email string. For an additional account-ID restriction, optionally set `ALLOWED_GOOGLE_SUB` to that account's Google subject identifier.

### Optional administrator/fallback sync token

Google sign-in can be used without a long sync token. If you want the token alternative, generate a random value locally and store it as a Worker secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put REMINDER_SYNC_TOKEN
```

Paste the generated value at the prompt. It must be at least 32 characters. Keep it private; never bake it into frontend source, `wrangler.jsonc`, public build variables, or committed files. Anyone with this token can read/change reminder settings, access workspace ciphertext, and trigger test messages.

## 3. Optional email or SMS providers

Workspace sync does not require a messaging provider. To enable deadline messages, configure at least one provider through secret prompts:

```powershell
# Email, using an approved Resend sender:
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put REMINDER_EMAIL_FROM

# Optional SMS, using a Twilio SMS-capable sender:
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER
```

Email setup: [Resend Send Email](https://resend.com/docs/api-reference/emails/send-email). SMS setup: [Twilio Messages resource](https://www.twilio.com/docs/messaging/api/message-resource). Verify sender/recipient permissions, account restrictions, fees, and delivery status in the provider dashboard. Provider secrets never reach the frontend or workspace backups.

## 4. Deploy and connect

```powershell
npx wrangler deploy
```

Use the returned HTTPS Worker URL in Karen's Load's cloud connection settings. Sign in with the allowed Google account, or use the optional sync token. Set a separate encryption passphrase for the shared workspace, synchronize the first device, then connect the other device using the same passphrase. An existing cloud version is downloaded and decrypted rather than silently replaced.

The Worker is for a **single shared personal workspace**, not separate workspaces for multiple users. Both devices need a connection to synchronize changes. Offline work remains local until a successful sync. If two devices edit independently, the version check returns a conflict; download/review the latest version before retrying. The server never silently overwrites a newer version. A workspace save also commits its redacted reminder counts/dates in the same database transaction. Delayed updates from an older device cannot replace the newer workspace's reminder dates.

GitHub Pages serves only the static frontend and cannot run this API or its scheduler. Only static app source belongs in a GitHub repository. Keep `.env`, `.dev.vars`, provider secrets, tokens, runtime files, patient exports, and documents out of Git. Local browser records remain separate until cloud sync is connected. Moving from localhost to Pages can use a backup/restore or the connected encrypted workspace.

## Reminder schedule

After connecting, save the desired recipients, channels, deadline window, and daily time. The app uses **Pacific Time (`America/Los_Angeles`)** for its business dates and reminder settings, with automatic PST/PDT daylight-saving changes. Send one explicit test and verify arrival before relying on daily messages. The cloud cron checks every five minutes, at or after the configured Pacific time. Changes to triggers may take time to propagate; see [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

A 3-day window includes today and the following three calendar days. The overdue option also includes earlier unfinished work. Completed cases/tasks are omitted before synchronization. The laptop can be off after the latest deadline snapshot is synchronized. Offline edits are unknown to the scheduler until the next successful sync, so it continues using the previous saved dates.

Atomic D1 claims prevent concurrent daily sends for the same channel. Provider acceptance does not prove delivery. Email retries after 15 minutes reuse the original payload and Resend idempotency key; changing preferences stops retries for the earlier configuration that day. SMS is recorded before sending and never retried automatically that day because a timeout may still have delivered it. Check the provider dashboard before deliberately sending a test retry; extra tests may incur charges. Reminder delivery history is pruned after approximately 35 days, including while reminders are disabled.

## Storage bounds and cleanup

Encrypted metadata requests are capped at 10 MiB JSON and 8 MiB decoded ciphertext; base64 overhead makes the practical ciphertext limit about 7.5 MiB. Each encrypted file is capped at 25 MiB plus 64 bytes of encryption overhead. File reservations have a shared 100 MiB allowance plus bounded encryption overhead. Failed/orphan uploads count toward that allowance and can be retried with the same UUID and identical bytes.

Uploaded files are immutable: reusing a UUID with different ciphertext is rejected. The service does not automatically delete remote file objects, previous encrypted metadata versions, or objects left by a conflicted save, because another device may still reference them. Removing a local attachment therefore does not immediately remove every remote encrypted copy. An owner can deliberately reset the private bucket/database after downloading and verifying a backup; that resets the shared workspace and requires reconnecting devices. Previous metadata envelopes are not included in the file quota.

Disable daily reminders and save **before disconnecting**. Removing a browser token, signing out, or locking encryption alone does not stop an already-enabled scheduler. Rotate `REMINDER_SYNC_TOKEN` to revoke token connections, or change the allowed Google account to revoke that account. Delete the Worker to stop its schedule, and delete its D1/R2 storage to remove the cloud workspace and metadata. Provider logs have separate retention policies.

## HTTP contract

Actual requests use `Authorization: Bearer <verified Google ID token or REMINDER_SYNC_TOKEN>`. Browser origins must match `ALLOWED_ORIGIN`; preflight allows GET/PUT/POST and Authorization/Content-Type/X-Weekwise-Request. Authenticated server-side requests without Origin are supported. Tokens are never accepted in URL query strings.

| Request             | Body                                                 | Result                                                                                             |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /workspace`    | —                                                    | `{version,updatedAt,payload:null\|{version:1,salt,iv,data}}`                                       |
| `PUT /workspace`    | `{expectedVersion,payload,snapshot?}` JSON           | `{version,updatedAt}`; optional redacted dates commit atomically; HTTP 409 on conflict             |
| `PUT /files/<UUID>` | Encrypted bytes, `application/octet-stream`          | `{id,bytes,sha256,existed}`; HTTP 409 if ID already has different content                          |
| `GET /files/<UUID>` | —                                                    | Opaque encrypted binary, or HTTP 404                                                               |
| `GET /status`       | —                                                    | `{available,mode:"cloud",configured,config,timeZone,lastRun,lastError,lastSent,snapshotUpdatedAt}` |
| `PUT /config`       | `{config,timeZone,snapshot?,workspaceVersion?}` JSON | Reminder status                                                                                    |
| `PUT /snapshot`     | `{snapshot,workspaceVersion?}` JSON                  | Reminder status; preferences preserved                                                             |
| `POST /test`        | `{}` JSON                                            | `{results,status}`; partial provider failure returns HTTP 502                                      |

The metadata envelope uses canonical base64, a 16-byte salt, a 12-byte AES-GCM IV, and ciphertext including its authentication tag. Its encryption algorithm/derivation are implemented by the browser, not the server. Binary attachments use a 12-byte IV followed by AES-GCM ciphertext. Unknown plaintext metadata fields are discarded.

Reminder `config` uses `{enabled,channels:["email","sms"],email,phone,daysAhead,time:"09:00",includeOverdue}`. The readable `snapshot` is `{caseCount,caseDueDates:["YYYY-MM-DD"],taskDueDates:["YYYY-MM-DD"]}`. Provider secrets and encryption keys are never returned by the API.

After a shared workspace exists, standalone reminder snapshot updates require `workspaceVersion` equal to its current version; missing/stale versions return HTTP 409. A config update without a snapshot can change recipients or disable reminders independently. Reminder-only installations with workspace version 0 can omit this version. Scheduled sends pause if an older client saves encrypted metadata without corresponding reminder dates.

Run `npm test` from the project root. Tests use real in-memory SQLite, an in-memory R2 adapter, generated test Google keys, and mocked provider calls. They do not deploy resources or send real messages. The deployed API, Google configuration, cron, and actual provider delivery still require verification in your accounts.

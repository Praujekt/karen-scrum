import {
  CloudReminderError,
  deadlineSummary,
  providerStatus,
  validateConfig,
  validateSnapshot,
  validateTimeZone,
  zonedClock,
} from "./contracts.mjs";
import { handleWorkspaceRequest } from "./workspace.mjs";
import { verifyGoogleIdToken } from "./google-auth.mjs";

const encoder = new TextEncoder();
const securityHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  Vary: "Origin",
};
function json(status, body, cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders, ...cors },
  });
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  let allowed;
  try {
    allowed = new URL(env.ALLOWED_ORIGIN);
  } catch {
    throw new CloudReminderError("This browser origin is not allowed.", 403);
  }
  if (
    allowed.origin !== env.ALLOWED_ORIGIN ||
    !["https:", "http:"].includes(allowed.protocol) ||
    origin !== allowed.origin
  )
    throw new CloudReminderError("This browser origin is not allowed.", 403);
  return { "Access-Control-Allow-Origin": origin };
}
async function authorized(request, env, fetchImpl) {
  const secret = env.REMINDER_SYNC_TOKEN;
  const hasSyncToken = typeof secret === "string" && secret.length >= 32;
  const hasGoogle = Boolean(env.GOOGLE_CLIENT_ID && env.ALLOWED_GOOGLE_EMAIL);
  if (!hasSyncToken && !hasGoogle)
    throw new CloudReminderError(
      "Cloud authentication is not configured.",
      503,
    );
  const header = request.headers.get("Authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || provided.length > 8192) return false;
  if (hasSyncToken) {
    const [expected, actual] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(secret)),
      crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    ]);
    const left = new Uint8Array(expected),
      right = new Uint8Array(actual);
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
    if (difference === 0) return true;
  }
  return hasGoogle
    ? Boolean(await verifyGoogleIdToken(provided, env, { fetchImpl }))
    : false;
}
async function bodyJson(request) {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new CloudReminderError("Use application/json for this request.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new CloudReminderError("A JSON body is required.");
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new CloudReminderError(
          "The deadline snapshot is too large.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(combined));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new CloudReminderError("Use a valid JSON object.");
  }
}
async function stateRow(env) {
  const row = await env.DB.prepare(
    "SELECT * FROM reminder_state WHERE id = 1",
  ).first();
  if (!row)
    throw new CloudReminderError(
      "The cloud reminder database needs its schema applied.",
      503,
    );
  return row;
}
async function requireSnapshotWorkspaceVersion(body, env) {
  const row = await env.DB.prepare(
    "SELECT version FROM encrypted_workspace WHERE id = 1",
  ).first();
  if (!row)
    throw new CloudReminderError(
      "Apply the cloud database schema to enable versioned deadline updates.",
      503,
    );
  const provided =
    body.workspaceVersion === undefined && row.version === 0
      ? 0
      : body.workspaceVersion;
  if (!Number.isSafeInteger(provided) || provided !== row.version) {
    const error = new CloudReminderError(
      "Refresh or connect the shared workspace before updating reminder dates. Another device may have a newer version.",
      409,
    );
    error.workspaceVersion = row.version;
    throw error;
  }
  return provided;
}
async function snapshotConflict(env) {
  const row = await env.DB.prepare(
    "SELECT version FROM encrypted_workspace WHERE id = 1",
  ).first();
  const error = new CloudReminderError(
    "The shared workspace changed while saving reminder dates. Refresh it before trying again.",
    409,
  );
  error.workspaceVersion = row?.version;
  throw error;
}
async function status(env) {
  const row = await stateRow(env);
  const accepted = await env.DB.prepare(
    "SELECT channel, MAX(accepted_at) AS at FROM delivery_claims WHERE status = 'accepted' GROUP BY channel",
  ).all();
  return {
    available: true,
    mode: "cloud",
    configured: providerStatus(env),
    config: JSON.parse(row.config_json),
    timeZone: row.time_zone,
    lastRun: row.last_run,
    lastError: row.last_error,
    lastSent: Object.fromEntries(
      accepted.results.map((value) => [value.channel, value.at]),
    ),
    snapshotUpdatedAt: row.snapshot_updated_at,
  };
}
async function hash(text) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(text)),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
function makePayload(channel, config, text) {
  return { to: channel === "email" ? config.email : config.phone, text };
}
async function sendProvider(channel, payload, env, idempotencyKey, fetchImpl) {
  if (!providerStatus(env)[channel])
    throw new CloudReminderError(
      `${channel === "sms" ? "SMS" : "Email"} provider is not configured.`,
    );
  if (!payload.to) throw new CloudReminderError("A recipient is required.");
  let response;
  if (channel === "email")
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: env.REMINDER_EMAIL_FROM,
        to: [payload.to],
        subject: "Weekwise · Your deadline reminder",
        text: payload.text,
      }),
      signal: AbortSignal.timeout(20000),
    });
  else
    response = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: payload.to,
          From: env.TWILIO_FROM_NUMBER,
          Body: payload.text,
        }).toString(),
        signal: AbortSignal.timeout(20000),
      },
    );
  if (!response.ok)
    throw new CloudReminderError(
      `${channel === "sms" ? "SMS" : "Email"} provider rejected the message (HTTP ${response.status}). Check its dashboard and cloud secrets.`,
    );
  return { accepted: true };
}
function safeProviderError(channel, error) {
  return error instanceof CloudReminderError
    ? error.message
    : `${channel === "sms" ? "SMS" : "Email"} could not reach the provider. Check the provider dashboard.`;
}

export function createCloudReminderWorker({
  fetchImpl = (...args) => fetch(...args),
  now = () => new Date(),
} = {}) {
  async function check(env) {
    const row = await stateRow(env),
      config = validateConfig(
        JSON.parse(row.config_json),
        {},
        { checkProviders: false },
      );
    const current = now(),
      clock = zonedClock(current, row.time_zone);
    // Cron continues to prune metadata even when sending is disabled or there
    // is no due work, so the retention promise does not depend on new sends.
    await env.DB.prepare(
      "DELETE FROM delivery_claims WHERE day < date(?, '-35 days')",
    )
      .bind(clock.day)
      .run();
    if (!config.enabled) return { skipped: "disabled" };
    const workspace = await env.DB.prepare(
      "SELECT version FROM encrypted_workspace WHERE id = 1",
    ).first();
    if (workspace && workspace.version !== row.snapshot_workspace_version)
      return { skipped: "workspace-snapshot-pending" };
    if (clock.time < config.time) return { skipped: "before-time" };
    const summary = deadlineSummary(
      validateSnapshot(JSON.parse(row.snapshot_json)),
      config,
      clock.day,
    );
    const timestamp = current.toISOString(),
      results = {},
      errors = [];
    await env.DB.prepare("UPDATE reminder_state SET last_run = ? WHERE id = 1")
      .bind(timestamp)
      .run();
    if (!summary.cases && !summary.tasks) {
      await env.DB.prepare(
        "UPDATE reminder_state SET last_error = NULL WHERE id = 1",
      ).run();
      return { skipped: "no-deadlines" };
    }
    const text = `Weekwise reminder: ${summary.tasks} unfinished task${summary.tasks === 1 ? "" : "s"} and ${summary.cases} active case deadline${summary.cases === 1 ? "" : "s"} due through ${summary.through}${config.includeOverdue ? ", including overdue work" : ""}. Open Weekwise to review. No patient information is included.`;
    for (const channel of config.channels) {
      const payload = makePayload(channel, config, text);
      const key =
        "weekwise-" +
        (
          await hash(`${clock.day}|${channel}|${JSON.stringify(payload)}`)
        ).slice(0, 48);
      const inserted = await env.DB.prepare(
        "INSERT INTO delivery_claims (day, channel, status, attempted_at, payload_json, idempotency_key, config_revision) SELECT ?, ?, 'attempted', ?, ?, ?, ? FROM reminder_state WHERE id = 1 AND config_revision = ? AND snapshot_revision = ? AND snapshot_workspace_version = (SELECT version FROM encrypted_workspace WHERE id = 1) AND json_extract(config_json, '$.enabled') = 1 ON CONFLICT (day, channel) DO NOTHING",
      )
        .bind(
          clock.day,
          channel,
          timestamp,
          JSON.stringify(payload),
          key,
          row.config_revision,
          row.config_revision,
          row.snapshot_revision,
        )
        .run();
      let claim = await env.DB.prepare(
        "SELECT * FROM delivery_claims WHERE day = ? AND channel = ?",
      )
        .bind(clock.day, channel)
        .first();
      if (!inserted.meta.changes) {
        if (!claim) {
          results[channel] = { skipped: "settings-changed" };
          continue;
        }
        const mayRetry =
          channel === "email" &&
          claim.config_revision === row.config_revision &&
          ["failed", "attempted"].includes(claim.status) &&
          current.valueOf() - Date.parse(claim.attempted_at) >= 15 * 60 * 1000;
        if (!mayRetry) {
          results[channel] = { skipped: "already-attempted" };
          if (claim.error) errors.push(claim.error);
          continue;
        }
        // Atomic compare-and-update makes overlapping cron invocations share one
        // retry owner. Reuse the original payload and key if a timeout hid success.
        const retried = await env.DB.prepare(
          "UPDATE delivery_claims SET status = 'attempted', attempted_at = ?, attempts = attempts + 1, error = NULL WHERE day = ? AND channel = ? AND attempted_at = ? AND status = ? AND EXISTS (SELECT 1 FROM reminder_state WHERE id = 1 AND config_revision = ? AND json_extract(config_json, '$.enabled') = 1)",
        )
          .bind(
            timestamp,
            clock.day,
            channel,
            claim.attempted_at,
            claim.status,
            row.config_revision,
          )
          .run();
        if (!retried.meta.changes) {
          results[channel] = { skipped: "already-attempted" };
          continue;
        }
        claim = { ...claim, attempted_at: timestamp };
      }
      try {
        results[channel] = await sendProvider(
          channel,
          JSON.parse(claim.payload_json),
          env,
          claim.idempotency_key,
          fetchImpl,
        );
        await env.DB.prepare(
          "UPDATE delivery_claims SET status = 'accepted', accepted_at = ?, error = NULL WHERE day = ? AND channel = ? AND attempted_at = ?",
        )
          .bind(timestamp, clock.day, channel, timestamp)
          .run();
      } catch (error) {
        const message = safeProviderError(channel, error);
        errors.push(message);
        results[channel] = { accepted: false, error: message };
        await env.DB.prepare(
          "UPDATE delivery_claims SET status = 'failed', error = ? WHERE day = ? AND channel = ? AND attempted_at = ?",
        )
          .bind(message, clock.day, channel, timestamp)
          .run();
      }
    }
    await env.DB.prepare(
      "UPDATE reminder_state SET last_error = ? WHERE id = 1",
    )
      .bind(errors.length ? errors.join(" ") : null)
      .run();
    return { results };
  }
  async function fetchHandler(request, env) {
    let cors = {};
    try {
      cors = corsHeaders(request, env);
      if (request.method === "OPTIONS") {
        if (!request.headers.get("Origin"))
          throw new CloudReminderError("A browser origin is required.", 403);
        const requestedMethod = request.headers.get(
          "Access-Control-Request-Method",
        );
        if (!["GET", "PUT", "POST"].includes(requestedMethod))
          throw new CloudReminderError("Method not allowed.", 405);
        const requestedHeaders = (
          request.headers.get("Access-Control-Request-Headers") || ""
        )
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        if (
          requestedHeaders.some(
            (value) =>
              !["authorization", "content-type", "x-weekwise-request"].includes(
                value,
              ),
          )
        )
          throw new CloudReminderError("Request header not allowed.", 403);
        return new Response(null, {
          status: 204,
          headers: {
            ...securityHeaders,
            ...cors,
            "Access-Control-Allow-Methods": "GET, PUT, POST",
            "Access-Control-Allow-Headers":
              "Authorization, Content-Type, X-Weekwise-Request",
            "Access-Control-Max-Age": "600",
          },
        });
      }
      if (!(await authorized(request, env, fetchImpl)))
        return json(
          401,
          {
            error:
              "Sign in with the allowed Google account or use a valid cloud sync token.",
          },
          cors,
        );
      const workspaceResponse = await handleWorkspaceRequest(request, env, {
        cors,
        now,
      });
      if (workspaceResponse) return workspaceResponse;
      const pathname = new URL(request.url).pathname;
      if (request.method === "GET" && pathname === "/status")
        return json(200, await status(env), cors);
      if (request.method === "PUT" && pathname === "/config") {
        const body = await bodyJson(request),
          config = validateConfig(body.config, env),
          timeZone = validateTimeZone(body.timeZone);
        const snapshot =
          body.snapshot === undefined ? null : validateSnapshot(body.snapshot);
        await stateRow(env);
        const workspaceVersion = snapshot
          ? await requireSnapshotWorkspaceVersion(body, env)
          : null;
        const saved = await env.DB.prepare(
          "UPDATE reminder_state SET config_json = ?, time_zone = ?, config_revision = config_revision + 1, snapshot_json = COALESCE(?, snapshot_json), snapshot_revision = snapshot_revision + ?, snapshot_updated_at = CASE WHEN ? IS NULL THEN snapshot_updated_at ELSE ? END, snapshot_workspace_version = COALESCE(?, snapshot_workspace_version) WHERE id = 1 AND (? IS NULL OR EXISTS (SELECT 1 FROM encrypted_workspace WHERE id = 1 AND version = ?))",
        )
          .bind(
            JSON.stringify(config),
            timeZone,
            snapshot ? JSON.stringify(snapshot) : null,
            snapshot ? 1 : 0,
            snapshot ? "yes" : null,
            now().toISOString(),
            workspaceVersion,
            workspaceVersion,
            workspaceVersion,
          )
          .run();
        if (!saved.meta.changes) await snapshotConflict(env);
        return json(200, await status(env), cors);
      }
      if (request.method === "PUT" && pathname === "/snapshot") {
        const body = await bodyJson(request),
          snapshot = validateSnapshot(body.snapshot);
        await stateRow(env);
        const workspaceVersion = await requireSnapshotWorkspaceVersion(
          body,
          env,
        );
        const saved = await env.DB.prepare(
          "UPDATE reminder_state SET snapshot_json = ?, snapshot_revision = snapshot_revision + 1, snapshot_updated_at = ?, snapshot_workspace_version = ? WHERE id = 1 AND EXISTS (SELECT 1 FROM encrypted_workspace WHERE id = 1 AND version = ?)",
        )
          .bind(
            JSON.stringify(snapshot),
            now().toISOString(),
            workspaceVersion,
            workspaceVersion,
          )
          .run();
        if (!saved.meta.changes) await snapshotConflict(env);
        return json(200, await status(env), cors);
      }
      if (request.method === "POST" && pathname === "/test") {
        await bodyJson(request);
        const row = await stateRow(env),
          config = validateConfig(
            JSON.parse(row.config_json),
            {},
            { checkProviders: false },
          );
        if (!config.channels.length)
          throw new CloudReminderError(
            "Select and save at least one reminder channel first.",
          );
        const results = {},
          errors = [];
        for (const channel of config.channels) {
          try {
            results[channel] = await sendProvider(
              channel,
              makePayload(
                channel,
                config,
                "Weekwise test reminder. Your cloud reminder connection is working. No patient information is included.",
              ),
              env,
              "weekwise-test-" + crypto.randomUUID(),
              fetchImpl,
            );
          } catch (error) {
            const message = safeProviderError(channel, error);
            errors.push(message);
            results[channel] = { accepted: false, error: message };
          }
        }
        if (errors.length)
          return json(
            502,
            { error: errors.join(" "), results, status: await status(env) },
            cors,
          );
        return json(200, { results, status: await status(env) }, cors);
      }
      return json(404, { error: "Unknown reminder endpoint." }, cors);
    } catch (error) {
      return json(
        error instanceof CloudReminderError ? error.status : 500,
        {
          error:
            error instanceof CloudReminderError
              ? error.message
              : "The cloud reminder service could not complete the request.",
          ...(Number.isSafeInteger(error.workspaceVersion)
            ? { version: error.workspaceVersion }
            : {}),
        },
        cors,
      );
    }
  }
  return {
    fetch: fetchHandler,
    scheduled(controller, env, context) {
      context.waitUntil(check(env));
    },
    check,
  };
}
export default createCloudReminderWorker();

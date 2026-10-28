import { CloudReminderError, validateSnapshot } from "./contracts.mjs";

export const MAX_WORKSPACE_JSON_BYTES = 10 * 1024 * 1024;
export const MAX_WORKSPACE_CIPHERTEXT_BYTES = 8 * 1024 * 1024;
export const MAX_ENCRYPTED_FILE_BYTES = 25 * 1024 * 1024 + 64;
export const MAX_TOTAL_ENCRYPTED_FILE_BYTES = 100 * 1024 * 1024 + 64 * 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  Vary: "Origin",
};
function json(status, body, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...baseHeaders,
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function decodedBase64Length(value, maximum) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new CloudReminderError(
      "Use canonical base64 for encrypted workspace fields.",
    );
  let decoded;
  try {
    decoded = atob(value);
  } catch {
    throw new CloudReminderError(
      "The encrypted workspace contains invalid base64.",
    );
  }
  if (btoa(decoded) !== value || decoded.length > maximum)
    throw new CloudReminderError(
      "The encrypted workspace contains invalid or oversized base64.",
    );
  return decoded.length;
}
export function validateEncryptedPayload(value) {
  if (!object(value) || value.version !== 1)
    throw new CloudReminderError("Use encrypted workspace payload version 1.");
  if (decodedBase64Length(value.salt, 16) !== 16)
    throw new CloudReminderError("The encryption salt must contain 16 bytes.");
  if (decodedBase64Length(value.iv, 12) !== 12)
    throw new CloudReminderError("The encryption IV must contain 12 bytes.");
  if (decodedBase64Length(value.data, MAX_WORKSPACE_CIPHERTEXT_BYTES) < 16)
    throw new CloudReminderError(
      "The encrypted workspace is missing its authentication tag.",
    );
  // The server stores an explicit ciphertext envelope only. It neither receives
  // an encryption password/key nor accepts extra patient-name/notes fields.
  return { version: 1, salt: value.salt, iv: value.iv, data: value.data };
}
async function readBytes(request, maximum) {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
    throw new CloudReminderError("The encrypted upload is too large.", 413);
  if (!request.body)
    throw new CloudReminderError("An encrypted upload body is required.");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new CloudReminderError("The encrypted upload is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function workspaceRow(env) {
  const row = await env.DB.prepare(
    "SELECT version, updated_at, payload_key FROM encrypted_workspace WHERE id = 1",
  ).first();
  if (!row)
    throw new CloudReminderError(
      "Apply the cloud database schema to enable workspace sync.",
      503,
    );
  return row;
}
async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
function fileKey(id) {
  return "workspace-files/" + id;
}
function requireFileStorage(env) {
  if (!env.FILES || typeof env.FILES.put !== "function")
    throw new CloudReminderError(
      "Bind the private FILES R2 bucket to enable encrypted file sync.",
      503,
    );
}

// Called only after the parent Worker has checked bearer authentication and the
// browser Origin. Return null for unrelated reminder endpoints.
export async function handleWorkspaceRequest(
  request,
  env,
  { cors = {}, now = () => new Date() } = {},
) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/workspace") {
    if (request.method === "GET") {
      const row = await workspaceRow(env);
      let payload = null;
      if (row.payload_key !== null) {
        requireFileStorage(env);
        const encrypted = await env.FILES.get(row.payload_key);
        if (!encrypted)
          throw new CloudReminderError(
            "The encrypted cloud workspace could not be found. Your local workspace has not been changed.",
            503,
          );
        try {
          payload = JSON.parse(await encrypted.text());
        } catch {
          throw new CloudReminderError(
            "The encrypted cloud workspace could not be read. Your local workspace has not been changed.",
            503,
          );
        }
      }
      return json(
        200,
        { version: row.version, updatedAt: row.updated_at, payload },
        cors,
      );
    }
    if (request.method !== "PUT")
      return json(
        405,
        { error: "Use GET or PUT for encrypted workspace sync." },
        cors,
      );
    if (
      !request.headers
        .get("Content-Type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      throw new CloudReminderError(
        "Use application/json for encrypted workspace metadata.",
        415,
      );
    const bytes = await readBytes(request, MAX_WORKSPACE_JSON_BYTES);
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new CloudReminderError(
        "Use a valid JSON object for encrypted workspace metadata.",
      );
    }
    if (
      !object(body) ||
      !Number.isSafeInteger(body.expectedVersion) ||
      body.expectedVersion < 0
    )
      throw new CloudReminderError(
        "An expected workspace version is required.",
      );
    const payload = validateEncryptedPayload(body.payload);
    const snapshot =
      body.snapshot === undefined ? null : validateSnapshot(body.snapshot);
    const current = await workspaceRow(env);
    if (current.version !== body.expectedVersion)
      return json(
        409,
        {
          error:
            "Another device updated this workspace. Download its latest version before saving your changes.",
          version: current.version,
        },
        cors,
      );
    requireFileStorage(env);
    // D1 rows are limited to 2 MB. Keep only a small atomic version pointer in
    // SQL, with the opaque envelope in immutable R2 storage. Uploading first
    // ensures the committed pointer never refers to a partially saved object.
    const payloadKey = "workspace-metadata/" + crypto.randomUUID() + ".json";
    await env.FILES.put(payloadKey, JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json" },
    });
    const timestamp = now().toISOString();
    const commit = env.DB.prepare(
      "UPDATE encrypted_workspace SET version = version + 1, updated_at = ?, payload_key = ? WHERE id = 1 AND version = ? RETURNING version, updated_at",
    ).bind(timestamp, payloadKey, body.expectedVersion);
    let updated;
    if (snapshot) {
      // One transaction commits both ciphertext identity and its redacted dates.
      // A losing CAS cannot change either, including when another device's
      // newer version has already committed while this object was uploading.
      const acceptedVersion = body.expectedVersion + 1;
      const snapshotCommit = env.DB.prepare(
        "UPDATE reminder_state SET snapshot_json = ?, snapshot_revision = snapshot_revision + 1, snapshot_updated_at = ?, snapshot_workspace_version = ? WHERE id = 1 AND EXISTS (SELECT 1 FROM encrypted_workspace WHERE id = 1 AND version = ? AND payload_key = ?)",
      ).bind(
        JSON.stringify(snapshot),
        timestamp,
        acceptedVersion,
        acceptedVersion,
        payloadKey,
      );
      const results = await env.DB.batch([commit, snapshotCommit]);
      updated = results[0].results?.[0] || null;
    } else updated = await commit.first();
    if (!updated) {
      const current = await workspaceRow(env);
      return json(
        409,
        {
          error:
            "Another device updated this workspace. Download its latest version before saving your changes.",
          version: current.version,
        },
        cors,
      );
    }
    return json(
      200,
      { version: updated.version, updatedAt: updated.updated_at },
      cors,
    );
  }
  if (!pathname.startsWith("/files/")) return null;
  const rawId = pathname.slice("/files/".length);
  if (!UUID.test(rawId))
    throw new CloudReminderError("Use a UUID for encrypted file identifiers.");
  const id = rawId.toLowerCase(),
    key = fileKey(id);
  requireFileStorage(env);
  if (request.method === "GET") {
    const object = await env.FILES.get(key);
    if (!object)
      return json(404, { error: "The encrypted file was not found." }, cors);
    return new Response(object.body, {
      status: 200,
      headers: {
        ...baseHeaders,
        ...cors,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "Content-Disposition": 'attachment; filename="weekwise-encrypted-file"',
      },
    });
  }
  if (request.method !== "PUT")
    return json(405, { error: "Use GET or PUT for encrypted files." }, cors);
  if (
    request.headers.get("Content-Type")?.toLowerCase().split(";")[0].trim() !==
    "application/octet-stream"
  )
    throw new CloudReminderError(
      "Use application/octet-stream for encrypted files.",
      415,
    );
  const bytes = await readBytes(request, MAX_ENCRYPTED_FILE_BYTES);
  if (bytes.length < 16)
    throw new CloudReminderError(
      "An encrypted file must include its authentication tag.",
    );
  const sha256 = await digest(bytes),
    timestamp = now().toISOString();
  // A single SQL statement reserves both immutable identity and quota. Failed
  // or orphaned uploads keep their reservation and can be retried with the same
  // bytes; automatically deleting them could break another device's workspace.
  await env.DB.prepare(
    "INSERT INTO encrypted_files (id, sha256, bytes, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COALESCE(SUM(bytes), 0) FROM encrypted_files) + ? <= ? ON CONFLICT (id) DO NOTHING",
  )
    .bind(
      id,
      sha256,
      bytes.length,
      timestamp,
      bytes.length,
      MAX_TOTAL_ENCRYPTED_FILE_BYTES,
    )
    .run();
  const reservation = await env.DB.prepare(
    "SELECT sha256, bytes FROM encrypted_files WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!reservation)
    throw new CloudReminderError(
      "Encrypted file storage is full (100 MiB plus encryption overhead, including previous uploads). No files were deleted.",
      413,
    );
  if (reservation.sha256 !== sha256 || reservation.bytes !== bytes.length)
    return json(
      409,
      {
        error:
          "This file identifier already belongs to different encrypted bytes. Use a new UUID.",
      },
      cors,
    );
  const existing = await env.FILES.head(key);
  if (existing) {
    if (
      existing.customMetadata?.sha256 !== sha256 ||
      existing.size !== bytes.length
    )
      return json(
        409,
        { error: "This encrypted file already exists with different content." },
        cors,
      );
    return json(200, { id, bytes: bytes.length, sha256, existed: true }, cors);
  }
  // Concurrent retries of the same UUID can write only the same SHA-256-checked
  // ciphertext. Different content is rejected by the permanent SQL reservation.
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { sha256 },
  });
  return json(201, { id, bytes: bytes.length, sha256, existed: false }, cors);
}

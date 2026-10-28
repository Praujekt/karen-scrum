import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createCloudReminderWorker } from "../cloud-reminders/worker.mjs";
import {
  MAX_ENCRYPTED_FILE_BYTES,
  MAX_TOTAL_ENCRYPTED_FILE_BYTES,
  MAX_WORKSPACE_JSON_BYTES,
  validateEncryptedPayload,
} from "../cloud-reminders/workspace.mjs";

const schema = await readFile(
  new URL("../cloud-reminders/schema.sql", import.meta.url),
  "utf8",
);
const token = "workspace-test-secret-".repeat(3),
  origin = "https://example.github.io";
const fileId = "4dc920c2-aecd-46de-b698-eb615d7b917d";
function d1Adapter(sqlite) {
  const statement = (sql, values = []) => ({
    bind(...args) {
      return statement(sql, args);
    },
    async first() {
      return sqlite.prepare(sql).get(...values) || null;
    },
    async all() {
      return { success: true, results: sqlite.prepare(sql).all(...values) };
    },
    batchRows() {
      return { success: true, results: sqlite.prepare(sql).all(...values) };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((value) => value.batchRows());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function fixture(t, { beforePut } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  t.after(() => sqlite.close());
  const objects = new Map();
  const FILES = {
    async put(key, value, options = {}) {
      if (beforePut) await beforePut(key);
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : new Uint8Array(value);
      objects.set(key, {
        bytes: bytes.slice(),
        customMetadata: options.customMetadata || {},
        httpMetadata: options.httpMetadata || {},
      });
    },
    async head(key) {
      const value = objects.get(key);
      return value
        ? { size: value.bytes.length, customMetadata: value.customMetadata }
        : null;
    },
    async get(key) {
      const value = objects.get(key);
      return value
        ? {
            body: new Response(value.bytes.slice()).body,
            size: value.bytes.length,
            text: async () => new TextDecoder().decode(value.bytes),
          }
        : null;
    },
  };
  const env = {
    DB: d1Adapter(sqlite),
    FILES,
    REMINDER_SYNC_TOKEN: token,
    ALLOWED_ORIGIN: origin,
  };
  const worker = createCloudReminderWorker({
    now: () => new Date("2026-10-27T17:00:00Z"),
    fetchImpl: async () => {
      throw new Error("No external requests are expected.");
    },
  });
  const request = (pathname, method = "GET", body, extraHeaders = {}) => {
    const binary = body instanceof Uint8Array;
    return worker.fetch(
      new Request("https://workspace.example.workers.dev" + pathname, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          Origin: origin,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": binary
                  ? "application/octet-stream"
                  : "application/json",
              }),
          ...extraHeaders,
        },
        body:
          body === undefined ? undefined : binary ? body : JSON.stringify(body),
      }),
      env,
    );
  };
  return { sqlite, objects, FILES, env, worker, request };
}
function payload(byte = 7) {
  return {
    version: 1,
    salt: Buffer.alloc(16, 1).toString("base64"),
    iv: Buffer.alloc(12, 2).toString("base64"),
    data: Buffer.alloc(64, byte).toString("base64"),
  };
}

test("new cloud workspace is empty and requires authentication and exact allowed origin", async (t) => {
  const { request } = fixture(t);
  assert.deepEqual(await (await request("/workspace")).json(), {
    version: 0,
    updatedAt: null,
    payload: null,
  });
  assert.equal(
    (await request("/workspace", "GET", undefined, { Authorization: "" }))
      .status,
    401,
  );
  assert.equal(
    (
      await request("/workspace", "GET", undefined, {
        Origin: "https://untrusted.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/files/" + fileId, "PUT", new Uint8Array(32), {
        Authorization: "",
      })
    ).status,
    401,
  );
});
test("workspace envelope validates salt, IV, authentication tag and canonical base64", () => {
  assert.deepEqual(validateEncryptedPayload(payload()), payload());
  assert.throws(
    () =>
      validateEncryptedPayload({
        ...payload(),
        salt: Buffer.alloc(15).toString("base64"),
      }),
    /salt/,
  );
  assert.throws(
    () =>
      validateEncryptedPayload({
        ...payload(),
        iv: Buffer.alloc(11).toString("base64"),
      }),
    /IV/,
  );
  assert.throws(
    () =>
      validateEncryptedPayload({
        ...payload(),
        data: Buffer.alloc(15).toString("base64"),
      }),
    /authentication tag/,
  );
  assert.throws(
    () => validateEncryptedPayload({ ...payload(), data: "not-base64" }),
    /base64/,
  );
  assert.throws(
    () => validateEncryptedPayload({ ...payload(), version: 2 }),
    /version/,
  );
});
test("metadata roundtrips through private R2 while D1 holds only a version pointer", async (t) => {
  const { request, sqlite, objects } = fixture(t);
  const envelope = {
    ...payload(),
    patientName: "Private Patient",
    notes: "Secret clinical note",
  };
  const saved = await request("/workspace", "PUT", {
    expectedVersion: 0,
    payload: envelope,
    patientName: "Discard this too",
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).version, 1);
  const restored = await (await request("/workspace")).json();
  assert.deepEqual(restored.payload, payload());
  assert.equal(restored.version, 1);
  assert.ok(restored.updatedAt);
  const row = sqlite.prepare("SELECT * FROM encrypted_workspace").get();
  assert.match(row.payload_key, /^workspace-metadata\/[\w-]+\.json$/);
  assert.equal("payload_json" in row, false);
  const text = new TextDecoder().decode(objects.get(row.payload_key).bytes);
  assert.equal(text.includes("Private Patient"), false);
  assert.equal(text.includes("Secret clinical"), false);
  sqlite.exec(schema);
  assert.equal((await (await request("/workspace")).json()).version, 1);
});
test("stale expected versions return 409 without overwriting the remote workspace", async (t) => {
  const { request, objects } = fixture(t);
  await request("/workspace", "PUT", {
    expectedVersion: 0,
    payload: payload(1),
  });
  const stale = await request("/workspace", "PUT", {
    expectedVersion: 0,
    payload: payload(2),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).version, 1);
  assert.deepEqual(
    (await (await request("/workspace")).json()).payload,
    payload(1),
  );
  assert.equal(objects.size, 1);
});
test("concurrent devices can commit only one update for the same expected version", async (t) => {
  let waiting = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { request } = fixture(t, {
    beforePut: async (key) => {
      if (key.startsWith("workspace-metadata/")) {
        waiting++;
        if (waiting === 2) release();
        await gate;
      }
    },
  });
  const responses = await Promise.all([
    request("/workspace", "PUT", { expectedVersion: 0, payload: payload(1) }),
    request("/workspace", "PUT", { expectedVersion: 0, payload: payload(2) }),
  ]);
  assert.deepEqual(responses.map((value) => value.status).sort(), [200, 409]);
  const winner = responses[0].status === 200 ? payload(1) : payload(2);
  const stored = await (await request("/workspace")).json();
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.payload, winner);
});
test("an R2 metadata failure leaves the committed version untouched", async (t) => {
  const { request, sqlite } = fixture(t, {
    beforePut: async () => {
      throw new Error("Storage unavailable");
    },
  });
  const result = await request("/workspace", "PUT", {
    expectedVersion: 0,
    payload: payload(),
  });
  assert.equal(result.status, 500);
  assert.equal(
    sqlite.prepare("SELECT version FROM encrypted_workspace").get().version,
    0,
  );
});
test("encrypted metadata HTTP size and expected-version shape are bounded", async (t) => {
  const { request } = fixture(t);
  assert.equal(
    (
      await request("/workspace", "PUT", {
        expectedVersion: -1,
        payload: payload(),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/workspace", "PUT", {
        expectedVersion: "0",
        payload: payload(),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/workspace",
        "PUT",
        { expectedVersion: 0, payload: payload() },
        { "Content-Type": "text/plain" },
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await request(
        "/workspace",
        "PUT",
        { expectedVersion: 0, payload: payload() },
        { "Content-Length": String(MAX_WORKSPACE_JSON_BYTES + 1) },
      )
    ).status,
    413,
  );
});
test("encrypted files roundtrip as opaque binary with immutable UUIDs and idempotent retries", async (t) => {
  const { request, objects } = fixture(t);
  const bytes = new Uint8Array(64).fill(42);
  const first = await request("/files/" + fileId, "PUT", bytes);
  assert.equal(first.status, 201);
  assert.equal((await first.json()).existed, false);
  const second = await request("/files/" + fileId.toUpperCase(), "PUT", bytes);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).existed, true);
  const different = await request(
    "/files/" + fileId,
    "PUT",
    new Uint8Array(64).fill(43),
  );
  assert.equal(different.status, 409);
  const get = await request("/files/" + fileId);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(get.headers.get("Access-Control-Allow-Origin"), origin);
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), bytes);
  assert.equal(objects.size, 1);
});
test("invalid IDs, content types, file sizes and deletion requests are rejected", async (t) => {
  const { request, objects } = fixture(t);
  assert.equal(
    (await request("/files/patient-name", "PUT", new Uint8Array(32))).status,
    400,
  );
  assert.equal(
    (await request("/files/" + fileId + "/extra", "PUT", new Uint8Array(32)))
      .status,
    400,
  );
  assert.equal(
    (await request("/files/" + fileId, "PUT", new Uint8Array(15))).status,
    400,
  );
  assert.equal(
    (
      await request("/files/" + fileId, "PUT", new Uint8Array(32), {
        "Content-Type": "text/plain",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await request("/files/" + fileId, "PUT", new Uint8Array(32), {
        "Content-Length": String(MAX_ENCRYPTED_FILE_BYTES + 1),
      })
    ).status,
    413,
  );
  assert.equal((await request("/files/" + fileId, "DELETE")).status, 405);
  assert.equal(objects.size, 0);
  assert.equal((await request("/files/" + fileId)).status, 404);
});
test("file quota reservations are atomic and identical retries do not consume extra space", async (t) => {
  const { request, sqlite } = fixture(t);
  sqlite
    .prepare(
      "INSERT INTO encrypted_files (id, sha256, bytes, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      "existing-reservation",
      "unused",
      MAX_TOTAL_ENCRYPTED_FILE_BYTES - 32,
      "2026-10-27T00:00:00Z",
    );
  const a = "ca7c905f-a7c9-4d6c-9948-1c949fda7d1c",
    b = "a668b404-0ee8-4350-bcb0-8c9a356f6279";
  const results = await Promise.all([
    request("/files/" + a, "PUT", new Uint8Array(32).fill(1)),
    request("/files/" + b, "PUT", new Uint8Array(32).fill(2)),
  ]);
  assert.deepEqual(results.map((value) => value.status).sort(), [201, 413]);
  const index = results[0].status === 201 ? 0 : 1;
  assert.equal(
    (
      await request(
        "/files/" + [a, b][index],
        "PUT",
        new Uint8Array(32).fill(index + 1),
      )
    ).status,
    200,
  );
  assert.equal(
    sqlite.prepare("SELECT SUM(bytes) AS bytes FROM encrypted_files").get()
      .bytes,
    MAX_TOTAL_ENCRYPTED_FILE_BYTES,
  );
});
test("failed file uploads retain a safe reservation and can be retried with the same bytes", async (t) => {
  let fail = true;
  const { request, sqlite } = fixture(t, {
    beforePut: async () => {
      if (fail) throw new Error("Storage unavailable");
    },
  });
  const bytes = new Uint8Array(32).fill(8);
  assert.equal((await request("/files/" + fileId, "PUT", bytes)).status, 500);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM encrypted_files").get().count,
    1,
  );
  fail = false;
  assert.equal((await request("/files/" + fileId, "PUT", bytes)).status, 201);
});
const dates = (day) => ({
  caseCount: 1,
  caseDueDates: [day],
  taskDueDates: [day],
});
test("workspace commits its version and redacted reminder dates atomically", async (t) => {
  const { request, sqlite } = fixture(t);
  const saved = await request("/workspace", "PUT", {
    expectedVersion: 0,
    payload: payload(),
    snapshot: { ...dates("2026-10-30"), patientName: "Private Patient" },
  });
  assert.equal(saved.status, 200);
  const row = sqlite
    .prepare(
      "SELECT snapshot_json, snapshot_workspace_version, snapshot_revision FROM reminder_state",
    )
    .get();
  assert.deepEqual(JSON.parse(row.snapshot_json), dates("2026-10-30"));
  assert.equal(row.snapshot_workspace_version, 1);
  assert.equal(row.snapshot_revision, 1);
  const stale = await request("/workspace", "PUT", {
    expectedVersion: 0,
    payload: payload(2),
    snapshot: dates("2026-11-01"),
  });
  assert.equal(stale.status, 409);
  assert.equal(
    sqlite
      .prepare("SELECT snapshot_workspace_version FROM reminder_state")
      .get().snapshot_workspace_version,
    1,
  );
});
test("a failed snapshot statement rolls back its workspace CAS and version", async (t) => {
  const { request, sqlite } = fixture(t);
  sqlite.exec(
    "CREATE TRIGGER refuse_snapshot BEFORE UPDATE OF snapshot_json ON reminder_state BEGIN SELECT RAISE(ABORT, 'Snapshot unavailable'); END",
  );
  const failed = await request("/workspace", "PUT", {
    expectedVersion: 0,
    payload: payload(),
    snapshot: dates("2026-10-30"),
  });
  assert.equal(failed.status, 500);
  assert.equal(
    sqlite.prepare("SELECT version FROM encrypted_workspace").get().version,
    0,
  );
  assert.equal(
    sqlite
      .prepare("SELECT snapshot_workspace_version FROM reminder_state")
      .get().snapshot_workspace_version,
    0,
  );
});
test("late device v2 cannot replace v3 reminder dates and missing versions are rejected", async (t) => {
  const { request, sqlite } = fixture(t);
  for (let expectedVersion = 0; expectedVersion < 3; expectedVersion++)
    assert.equal(
      (
        await request("/workspace", "PUT", {
          expectedVersion,
          payload: payload(expectedVersion),
          snapshot: dates("2026-11-0" + (expectedVersion + 1)),
        })
      ).status,
      200,
    );
  const late = await request("/snapshot", "PUT", {
    workspaceVersion: 2,
    snapshot: dates("2026-12-01"),
  });
  assert.equal(late.status, 409);
  assert.equal((await late.json()).version, 3);
  assert.equal(
    (await request("/snapshot", "PUT", { snapshot: dates("2026-12-02") }))
      .status,
    409,
  );
  assert.deepEqual(
    JSON.parse(
      sqlite.prepare("SELECT snapshot_json FROM reminder_state").get()
        .snapshot_json,
    ),
    dates("2026-11-03"),
  );
  assert.equal(
    (
      await request("/snapshot", "PUT", {
        workspaceVersion: 3,
        snapshot: dates("2026-11-04"),
      })
    ).status,
    200,
  );
});
test("config without dates stays editable while stale date/config combinations are rejected", async (t) => {
  const { request, sqlite } = fixture(t);
  await request("/workspace", "PUT", {
    expectedVersion: 0,
    payload: payload(),
    snapshot: dates("2026-10-30"),
  });
  const config = {
    enabled: false,
    channels: [],
    email: "",
    phone: "",
    daysAhead: 5,
    time: "10:00",
    includeOverdue: true,
  };
  assert.equal(
    (await request("/config", "PUT", { config, timeZone: "UTC" })).status,
    200,
  );
  assert.equal(
    (
      await request("/config", "PUT", {
        config: { ...config, daysAhead: 7 },
        timeZone: "UTC",
        snapshot: dates("2026-11-10"),
        workspaceVersion: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    JSON.parse(
      sqlite.prepare("SELECT config_json FROM reminder_state").get()
        .config_json,
    ).daysAhead,
    5,
  );
  assert.equal(
    (
      await request("/config", "PUT", {
        config,
        timeZone: "UTC",
        snapshot: dates("2026-11-10"),
        workspaceVersion: 1,
      })
    ).status,
    200,
  );
});
test("a delayed v2 workspace upload cannot replace reminder dates already committed at v3", async (t) => {
  let uploads = 0,
    entered,
    release;
  const paused = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const { request, sqlite } = fixture(t, {
    beforePut: async (key) => {
      if (key.startsWith("workspace-metadata/") && ++uploads === 2) {
        entered();
        await gate;
      }
    },
  });
  await request("/workspace", "PUT", {
    expectedVersion: 0,
    payload: payload(1),
    snapshot: dates("2026-11-01"),
  });
  const delayed = request("/workspace", "PUT", {
    expectedVersion: 1,
    payload: payload(9),
    snapshot: dates("2026-12-09"),
  });
  await paused;
  assert.equal(
    (
      await request("/workspace", "PUT", {
        expectedVersion: 1,
        payload: payload(2),
        snapshot: dates("2026-11-02"),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/workspace", "PUT", {
        expectedVersion: 2,
        payload: payload(3),
        snapshot: dates("2026-11-03"),
      })
    ).status,
    200,
  );
  release();
  assert.equal((await delayed).status, 409);
  const row = sqlite
    .prepare(
      "SELECT snapshot_json, snapshot_workspace_version FROM reminder_state",
    )
    .get();
  assert.equal(row.snapshot_workspace_version, 3);
  assert.deepEqual(JSON.parse(row.snapshot_json), dates("2026-11-03"));
});

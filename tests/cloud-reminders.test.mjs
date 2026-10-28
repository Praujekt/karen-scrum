import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createCloudReminderWorker } from "../cloud-reminders/worker.mjs";
import {
  deadlineSummary,
  defaultConfig,
  validateSnapshot,
  zonedClock,
} from "../cloud-reminders/contracts.mjs";

const schema = await readFile(
  new URL("../cloud-reminders/schema.sql", import.meta.url),
  "utf8",
);
const token = "a".repeat(64),
  origin = "https://example.github.io";
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
    async run() {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return { prepare: (sql) => statement(sql) };
}
function fixture(t, options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  t.after(() => sqlite.close());
  const calls = [];
  let clock = new Date("2026-10-27T17:00:00Z");
  const env = {
    DB: d1Adapter(sqlite),
    REMINDER_SYNC_TOKEN: token,
    ALLOWED_ORIGIN: origin,
    RESEND_API_KEY: "fake-email-secret",
    REMINDER_EMAIL_FROM: "test@example.org",
    TWILIO_ACCOUNT_SID: "ACfake",
    TWILIO_AUTH_TOKEN: "fake-sms-secret",
    TWILIO_FROM_NUMBER: "+15551234567",
    ...options.env,
  };
  const worker = createCloudReminderWorker({
    now: () => clock,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return options.send ? options.send(url, init) : { ok: true, status: 200 };
    },
  });
  const request = (pathname, method = "GET", body, headers = {}) =>
    worker.fetch(
      new Request("https://reminders.example.workers.dev" + pathname, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
  return {
    sqlite,
    worker,
    env,
    calls,
    request,
    setClock: (date) => {
      clock = new Date(date);
    },
  };
}
const configPayload = (overrides = {}) => ({
  config: {
    ...defaultConfig(),
    enabled: true,
    channels: ["email"],
    email: "recipient@example.org",
    ...overrides,
  },
  timeZone: "America/Los_Angeles",
  snapshot: {
    caseCount: 1,
    caseDueDates: ["2026-10-30"],
    taskDueDates: ["2026-10-26", "2026-10-28", "2026-11-01"],
  },
});

test("cloud clock uses IANA time zone across DST and local midnight", () => {
  assert.deepEqual(
    zonedClock(new Date("2026-11-01T08:30:00Z"), "America/Los_Angeles"),
    { day: "2026-11-01", time: "01:30" },
  );
  assert.deepEqual(
    zonedClock(new Date("2026-11-01T09:30:00Z"), "America/Los_Angeles"),
    { day: "2026-11-01", time: "01:30" },
  );
  assert.deepEqual(
    zonedClock(new Date("2026-10-28T07:00:00Z"), "America/Los_Angeles"),
    { day: "2026-10-28", time: "00:00" },
  );
});
test("deadline window uses calendar dates and strips patient fields", () => {
  const snapshot = validateSnapshot({
    caseCount: 1,
    caseDueDates: ["2026-11-02"],
    taskDueDates: ["2026-10-31", "2026-11-01", "2026-11-04"],
    patient: "Private Patient",
  });
  assert.equal("patient" in snapshot, false);
  assert.deepEqual(
    deadlineSummary(
      snapshot,
      { ...defaultConfig(), daysAhead: 2 },
      "2026-11-01",
    ),
    { day: "2026-11-01", through: "2026-11-03", cases: 1, tasks: 2 },
  );
  assert.equal(
    deadlineSummary(
      snapshot,
      { ...defaultConfig(), daysAhead: 2, includeOverdue: false },
      "2026-11-01",
    ).tasks,
    1,
  );
});
test("all cloud data endpoints require a strong bearer token", async (t) => {
  const { request, env, worker } = fixture(t);
  assert.equal(
    (await request("/status", "GET", undefined, { Authorization: "" })).status,
    401,
  );
  assert.equal(
    (
      await request("/status", "GET", undefined, {
        Authorization: "Bearer incorrect",
      })
    ).status,
    401,
  );
  assert.equal((await request("/status")).status, 200);
  assert.equal(
    (
      await worker.fetch(new Request("https://example.org/status"), {
        ...env,
        REMINDER_SYNC_TOKEN: "weak",
      })
    ).status,
    503,
  );
});
test("CORS allows only the configured exact origin and required preflight headers", async (t) => {
  const { worker, env, request } = fixture(t);
  const options = new Request("https://reminders.example.workers.dev/config", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers":
        "authorization, content-type, x-weekwise-request",
    },
  });
  const preflight = await worker.fetch(options, env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(
    (
      await request("/status", "GET", undefined, { Origin: origin })
    ).headers.get("Access-Control-Allow-Origin"),
    origin,
  );
  const denied = await request("/status", "GET", undefined, {
    Origin: "https://evil.example",
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.has("Access-Control-Allow-Origin"), false);
  assert.equal(
    (
      await request("/status", "GET", undefined, {
        Origin: "https://example.github.io/repository",
      })
    ).status,
    403,
  );
  const wrongHeader = new Request(options, {
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "x-unsafe-header",
    },
  });
  assert.equal((await worker.fetch(wrongHeader, env)).status, 403);
});
test("status never exposes provider secrets or sync tokens", async (t) => {
  const { request } = fixture(t);
  const response = await request("/status");
  const body = await response.json();
  assert.equal(body.mode, "cloud");
  assert.deepEqual(body.configured, { email: true, sms: true });
  assert.equal(JSON.stringify(body).includes("fake-email-secret"), false);
  assert.equal(JSON.stringify(body).includes(token), false);
  assert.deepEqual(body.lastSent, {});
});
test("config and snapshot API preserve one another and discard patient details", async (t) => {
  const { request, sqlite } = fixture(t);
  const payload = configPayload();
  payload.snapshot.name = "Private Patient";
  payload.config.unknown = "Private Note";
  assert.equal((await request("/config", "PUT", payload)).status, 200);
  const synced = await request("/snapshot", "PUT", {
    snapshot: {
      caseCount: 0,
      caseDueDates: [],
      taskDueDates: [],
      note: "Private Clinical Note",
    },
  });
  const body = await synced.json();
  assert.equal(body.config.enabled, true);
  assert.equal(body.timeZone, "America/Los_Angeles");
  assert.ok(body.snapshotUpdatedAt);
  const row = sqlite.prepare("SELECT * FROM reminder_state").get();
  assert.equal(JSON.stringify(row).includes("Private"), false);
  assert.equal(JSON.parse(row.snapshot_json).caseCount, 0);
});
test("invalid dates, time zones, channels and provider setup are rejected", async (t) => {
  const { request, worker, env } = fixture(t);
  assert.equal(
    (
      await request("/config", "PUT", {
        ...configPayload(),
        timeZone: "Imaginary/Zone",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/config", "PUT", configPayload({ channels: ["fax"] })))
      .status,
    400,
  );
  assert.equal(
    (
      await request("/snapshot", "PUT", {
        snapshot: {
          caseCount: 1,
          caseDueDates: ["2026-02-30"],
          taskDueDates: [],
        },
      })
    ).status,
    400,
  );
  const req = new Request("https://example.org/config", {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(configPayload()),
  });
  assert.equal(
    (await worker.fetch(req, { ...env, RESEND_API_KEY: "" })).status,
    400,
  );
});
test("cron sends from cloud without a local app and deduplicates the day per channel", async (t) => {
  const { request, worker, env, calls } = fixture(t);
  await request(
    "/config",
    "PUT",
    configPayload({ channels: ["email", "sms"], phone: "+15557654321" }),
  );
  const result = await worker.check(env);
  assert.equal(result.results.email.accepted, true);
  assert.equal(result.results.sms.accepted, true);
  assert.equal(calls.length, 2);
  assert.match(
    JSON.parse(calls[0].init.body).text,
    /2 unfinished tasks and 1 active case deadline/,
  );
  assert.match(calls[1].url, /Accounts\/ACfake\/Messages.json$/);
  await worker.check(env);
  assert.equal(calls.length, 2);
  const current = await (await request("/status")).json();
  assert.ok(current.lastSent.email);
  assert.ok(current.lastSent.sms);
});
test("simultaneous scheduled checks share one atomic D1 claim", async (t) => {
  let release;
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  const { request, worker, env, calls } = fixture(t, {
    send: async () => {
      await pause;
      return { ok: true, status: 200 };
    },
  });
  await request("/config", "PUT", configPayload());
  const first = worker.check(env),
    second = worker.check(env);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
});
test("SMS failures are claimed before sending and never automatically retried", async (t) => {
  const { request, worker, env, calls, setClock, sqlite } = fixture(t, {
    send: async () => {
      throw new Error("Ambiguous timeout");
    },
  });
  await request(
    "/config",
    "PUT",
    configPayload({ channels: ["sms"], phone: "+15557654321" }),
  );
  await worker.check(env);
  setClock("2026-10-27T20:00:00Z");
  await worker.check(env);
  assert.equal(calls.length, 1);
  assert.equal(
    sqlite.prepare("SELECT status FROM delivery_claims").get().status,
    "failed",
  );
});
test("email retry reuses its original payload and idempotency key", async (t) => {
  let attempts = 0;
  const { request, worker, env, calls, setClock } = fixture(t, {
    send: async () => ({ ok: ++attempts > 1, status: 500 }),
  });
  await request("/config", "PUT", configPayload());
  await worker.check(env);
  await worker.check(env);
  assert.equal(calls.length, 1);
  await request("/snapshot", "PUT", {
    snapshot: { caseCount: 1, caseDueDates: ["2026-10-27"], taskDueDates: [] },
  });
  setClock("2026-10-27T17:16:00Z");
  await worker.check(env);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.equal(
    calls[0].init.headers["Idempotency-Key"],
    calls[1].init.headers["Idempotency-Key"],
  );
});
test("changing recipient after a failed attempt does not retry the old recipient", async (t) => {
  const { request, worker, env, calls, setClock } = fixture(t, {
    send: async () => ({ ok: false, status: 500 }),
  });
  await request("/config", "PUT", configPayload());
  await worker.check(env);
  await request("/config", "PUT", configPayload({ email: "new@example.org" }));
  setClock("2026-10-27T18:00:00Z");
  await worker.check(env);
  assert.equal(calls.length, 1);
});
test("disabled, before-time and empty snapshots do not send", async (t) => {
  const { request, worker, env, calls } = fixture(t);
  assert.equal((await worker.check(env)).skipped, "disabled");
  await request("/config", "PUT", configPayload({ time: "11:00" }));
  assert.equal((await worker.check(env)).skipped, "before-time");
  await request("/config", "PUT", {
    ...configPayload(),
    snapshot: { caseCount: 0, caseDueDates: [], taskDueDates: [] },
  });
  assert.equal((await worker.check(env)).skipped, "no-deadlines");
  assert.equal(calls.length, 0);
});
test("explicit tests can send with scheduling disabled and never consume the daily claim", async (t) => {
  const { request, worker, env, calls, sqlite } = fixture(t);
  await request("/config", "PUT", configPayload({ enabled: false }));
  const response = await request("/test", "POST", {});
  assert.equal(response.status, 200);
  assert.match(JSON.parse(calls[0].init.body).text, /test reminder/);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM delivery_claims").get().count,
    0,
  );
  await request("/config", "PUT", configPayload());
  await worker.check(env);
  assert.equal(calls.length, 2);
});
test("delivery metadata expires even after reminders are disabled", async (t) => {
  const { request, worker, env, sqlite, setClock } = fixture(t);
  await request("/config", "PUT", configPayload());
  await worker.check(env);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM delivery_claims").get().count,
    1,
  );
  await request("/config", "PUT", configPayload({ enabled: false }));
  setClock("2026-12-10T17:00:00Z");
  await worker.check(env);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM delivery_claims").get().count,
    0,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import {
  createReminderService,
  deadlineSummary,
  defaultConfig,
  validDate,
  validatePayload,
} from "../reminder-service.mjs";
import { createWeekwiseServer } from "../server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  RESEND_API_KEY: "test-email-key",
  REMINDER_EMAIL_FROM: "Karen's Load <test@example.org>",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "test-sms-token",
  TWILIO_FROM_NUMBER: "+15551234567",
};
async function fixture(t, extra = {}) {
  const localRoot = path.join(root, ".local");
  await mkdir(localRoot, { recursive: true });
  const directory = await mkdtemp(path.join(localRoot, "tests-"));
  t.after(async () => {
    assert.ok(directory.startsWith(localRoot + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const calls = [];
  const service = createReminderService({
    dataPath: path.join(directory, "reminders.json"),
    env,
    now: () => new Date("2026-10-27T17:00:00Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
    ...extra,
  });
  return { service, calls, directory };
}
function payload(overrides = {}) {
  return {
    config: {
      ...defaultConfig(),
      enabled: true,
      channels: ["email"],
      email: "recipient@example.org",
      ...overrides,
    },
    snapshot: {
      caseCount: 2,
      caseDueDates: ["2026-10-30", "2026-11-02"],
      taskDueDates: ["2026-10-26", "2026-10-27", "2026-10-30", "2026-10-31"],
    },
  };
}

test("calendar validation rejects overflow and missing padding", () => {
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2024-02-29"), true);
  assert.equal(validDate("2026-13-01"), false);
  assert.equal(validDate("2026-1-01"), false);
});
test("window includes today, calendar end date and optional overdue work", () => {
  const p = payload();
  const date = new Date("2026-10-27T17:00:00Z");
  assert.deepEqual(deadlineSummary(p.snapshot, p.config, date), {
    today: "2026-10-27",
    through: "2026-10-30",
    cases: 1,
    tasks: 3,
  });
  p.config.includeOverdue = false;
  assert.equal(deadlineSummary(p.snapshot, p.config, date).tasks, 2);
  p.config.daysAhead = 0;
  assert.equal(deadlineSummary(p.snapshot, p.config, date).tasks, 1);
});
test("configuration rejects invalid channels, dates, recipients and missing providers", () => {
  assert.throws(
    () => validatePayload(payload({ channels: ["fax"] }), env),
    /channels/,
  );
  assert.throws(
    () => validatePayload(payload({ daysAhead: -1 }), env),
    /window/,
  );
  assert.throws(
    () => validatePayload(payload({ time: "25:00" }), env),
    /window/,
  );
  assert.throws(
    () => validatePayload(payload({ email: "invalid" }), env),
    /email/,
  );
  assert.throws(
    () => validatePayload(payload({ phone: "5551234" }), env),
    /international/,
  );
  assert.throws(() => validatePayload(payload(), {}), /provider/);
  const mismatch = payload();
  mismatch.snapshot.caseCount = 99;
  assert.throws(() => validatePayload(mismatch, env), /count/);
  const overflow = payload();
  overflow.snapshot.taskDueDates.push("2026-02-30");
  assert.throws(() => validatePayload(overflow, env), /dates/);
});
test("unknown patient data is discarded before saving a snapshot", async (t) => {
  const { service, directory } = await fixture(t);
  const p = payload();
  p.snapshot.patientName = "Private Patient";
  p.snapshot.notes = "private clinical note";
  p.config.token = "unwanted token";
  await service.save(p);
  const disk = await readFile(path.join(directory, "reminders.json"), "utf8");
  assert.equal(disk.includes("Private Patient"), false);
  assert.equal(disk.includes("private clinical"), false);
  assert.equal(disk.includes("unwanted token"), false);
  assert.equal(disk.includes(env.RESEND_API_KEY), false);
});
test("disabled reminders never contact a provider", async (t) => {
  const { service, calls } = await fixture(t);
  await service.save(payload({ enabled: false }));
  assert.deepEqual(await service.run(), { skipped: "disabled" });
  assert.equal(calls.length, 0);
});
test("nothing due and before-time checks never send", async (t) => {
  const { service, calls } = await fixture(t);
  await service.save(payload({ time: "11:00" }));
  assert.equal((await service.run()).skipped, "before-time");
  const p = payload();
  p.snapshot = { caseCount: 0, caseDueDates: [], taskDueDates: [] };
  await service.save(p);
  assert.equal((await service.run()).skipped, "no-deadlines");
  assert.equal(calls.length, 0);
});
test("email digest uses provider API, redacts cases, and deduplicates across service restarts", async (t) => {
  const { service, calls, directory } = await fixture(t);
  await service.save(payload());
  const first = await service.run();
  assert.equal(first.results.email.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.text, /3 unfinished tasks and 1 active case deadline/);
  assert.deepEqual(body.to, ["recipient@example.org"]);
  assert.match(calls[0].options.headers["Idempotency-Key"], /^weekwise-/);
  await service.run();
  assert.equal(calls.length, 1);
  const second = createReminderService({
    dataPath: path.join(directory, "reminders.json"),
    env,
    now: () => new Date("2026-10-27T22:00:00Z"),
    fetchImpl: async () => {
      throw new Error("Must not retry");
    },
  });
  assert.equal((await second.run()).results.email.skipped, "already-attempted");
});
test("both channels send once and SMS uses form encoding and basic authentication", async (t) => {
  const { service, calls } = await fixture(t);
  await service.save(
    payload({ channels: ["email", "sms"], phone: "+15557654321" }),
  );
  const result = await service.run();
  assert.equal(result.results.sms.accepted, true);
  assert.equal(calls.length, 2);
  const sms = calls[1];
  assert.match(sms.url, /Accounts\/ACtest\/Messages.json$/);
  assert.equal(new URLSearchParams(sms.options.body).get("To"), "+15557654321");
  assert.match(sms.options.headers.Authorization, /^Basic /);
  await service.run();
  assert.equal(calls.length, 2);
});
test("a failed SMS is not automatically repeated because delivery may be ambiguous", async (t) => {
  let attempts = 0;
  const { service } = await fixture(t, {
    fetchImpl: async () => {
      attempts++;
      throw new Error("Timeout");
    },
  });
  await service.save(payload({ channels: ["sms"], phone: "+15557654321" }));
  const first = await service.run();
  assert.equal(first.results.sms.accepted, false);
  await service.run();
  assert.equal(attempts, 1);
  assert.match((await service.getStatus()).lastError, /could not reach/);
});
test("email failure retries after 15 minutes and success is not resent", async (t) => {
  let clock = new Date("2026-10-27T17:00:00Z"),
    attempts = 0;
  const { service } = await fixture(t, {
    now: () => clock,
    fetchImpl: async () => ({ ok: ++attempts > 1, status: 500 }),
  });
  await service.save(payload());
  await service.run();
  await service.run();
  assert.equal(attempts, 1);
  clock = new Date("2026-10-27T17:16:00Z");
  await service.run();
  assert.equal(attempts, 2);
  await service.run();
  assert.equal(attempts, 2);
});
test("explicit test sends work while scheduling is disabled and do not consume the daily digest", async (t) => {
  const { service, calls } = await fixture(t);
  await service.save(payload({ enabled: false }));
  await service.run({ test: true });
  assert.equal(calls.length, 1);
  assert.match(JSON.parse(calls[0].options.body).text, /test reminder/);
  assert.deepEqual((await service.getStatus()).lastSent, {});
  await service.save(payload());
  await service.run();
  assert.equal(calls.length, 2);
});
test("removing credentials leaves saved preferences readable and reports send errors safely", async (t) => {
  const { service, directory } = await fixture(t);
  await service.save(payload());
  const withoutCredentials = createReminderService({
    dataPath: path.join(directory, "reminders.json"),
    env: {},
    now: () => new Date("2026-10-27T17:00:00Z"),
  });
  assert.equal((await withoutCredentials.getStatus()).config.enabled, true);
  const result = await withoutCredentials.run();
  assert.match(result.status.lastError, /not configured/);
});
test("snapshot-only synchronization preserves disabled settings and needs no provider credentials", async (t) => {
  const { service, directory } = await fixture(t);
  await service.save(payload());
  const withoutCredentials = createReminderService({
    dataPath: path.join(directory, "reminders.json"),
    env: {},
    now: () => new Date("2026-10-27T17:00:00Z"),
  });
  await withoutCredentials.syncSnapshot({
    caseCount: 1,
    caseDueDates: ["2026-11-01"],
    taskDueDates: [],
  });
  assert.equal((await withoutCredentials.getStatus()).config.enabled, true);
  await service.save(payload({ enabled: false }));
  await withoutCredentials.syncSnapshot({
    caseCount: 0,
    caseDueDates: [],
    taskDueDates: [],
    name: "Must be discarded",
  });
  assert.equal((await service.getStatus()).config.enabled, false);
  assert.equal(
    (await readFile(path.join(directory, "reminders.json"), "utf8")).includes(
      "Must be discarded",
    ),
    false,
  );
});
test("local HTTP API rejects cross-origin writes, missing headers, wrong hosts and malformed JSON", async (t) => {
  const { service, directory } = await fixture(t);
  const dist = path.join(directory, "dist");
  await mkdir(dist);
  await writeFile(
    path.join(dist, "index.html"),
    "<!doctype html><title>Test</title>",
  );
  const server = createWeekwiseServer({ service, staticDirectory: dist });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    Origin: origin,
    "X-Weekwise-Request": "1",
    "Content-Type": "application/json",
  };
  const status = await fetch(origin + "/api/reminders");
  assert.equal(status.status, 200);
  assert.equal((await status.json()).available, true);
  const cross = await fetch(origin + "/api/reminders", {
    method: "PUT",
    headers: { ...headers, Origin: "https://other.example" },
    body: JSON.stringify(payload()),
  });
  assert.equal(cross.status, 403);
  const missing = await fetch(origin + "/api/reminders", {
    method: "PUT",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(payload()),
  });
  assert.equal(missing.status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(
      origin + "/api/reminders",
      { headers: { Host: "other.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
  });
  assert.equal(wrongHostStatus, 403);
  const bad = await fetch(origin + "/api/reminders", {
    method: "PUT",
    headers,
    body: "{",
  });
  assert.equal(bad.status, 400);
  const valid = await fetch(origin + "/api/reminders", {
    method: "PUT",
    headers,
    body: JSON.stringify(payload()),
  });
  assert.equal(valid.status, 200);
  const synced = await fetch(origin + "/api/reminders/snapshot", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      snapshot: { caseCount: 0, caseDueDates: [], taskDueDates: [] },
    }),
  });
  assert.equal(synced.status, 200);
  assert.equal((await synced.json()).config.enabled, true);
  const page = await fetch(origin + "/");
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /script-src 'self'/,
  );
  assert.equal((await fetch(origin + "/.env")).status, 404);
  assert.equal((await fetch(origin + "/%2e%2e%2freminders.json")).status, 404);
});

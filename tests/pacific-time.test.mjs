import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReminderService,
  deadlineSummary,
  defaultConfig,
  pacificClock,
  TIME_ZONE,
} from "../reminder-service.mjs";
import { zonedClock } from "../cloud-reminders/contracts.mjs";

const require = createRequire(import.meta.url);
const model = require("../dist/model.js");
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("case dates change at Pacific midnight in both daylight and standard time", () => {
  assert.equal(model.TIME_ZONE, "America/Los_Angeles");
  assert.equal(model.TIME_ZONE_LABEL, "Pacific Time");
  assert.equal(TIME_ZONE, model.TIME_ZONE);
  for (const [instant, day] of [
    ["2026-10-28T06:59:59Z", "2026-10-27"],
    ["2026-10-28T07:00:00Z", "2026-10-28"],
    ["2026-12-01T07:59:59Z", "2026-11-30"],
    ["2026-12-01T08:00:00Z", "2026-12-01"],
  ]) {
    assert.equal(model.today(new Date(instant)), day);
    assert.equal(pacificClock(new Date(instant)).day, day);
    assert.equal(zonedClock(new Date(instant)).day, day);
  }
});

test("Pacific clock follows DST without shifting the case calendar day", () => {
  assert.deepEqual(pacificClock(new Date("2026-03-08T09:59:00Z")), {
    day: "2026-03-08",
    time: "01:59",
  });
  assert.deepEqual(pacificClock(new Date("2026-03-08T10:00:00Z")), {
    day: "2026-03-08",
    time: "03:00",
  });
  assert.deepEqual(pacificClock(new Date("2026-11-01T08:30:00Z")), {
    day: "2026-11-01",
    time: "01:30",
  });
  assert.deepEqual(pacificClock(new Date("2026-11-01T09:30:00Z")), {
    day: "2026-11-01",
    time: "01:30",
  });
});

test("deadline windows use Pacific dates independently of the machine time zone", () => {
  const serviceURL = new URL("../reminder-service.mjs", import.meta.url).href;
  const modelPath = fileURLToPath(new URL("../dist/model.js", import.meta.url));
  const program = `import { createRequire } from 'node:module'; import {deadlineSummary,pacificClock} from ${JSON.stringify(serviceURL)}; const M=createRequire(import.meta.url)(${JSON.stringify(modelPath)}); const now=new Date('2026-10-28T06:30:00Z'); console.log(JSON.stringify({day:M.today(now),clock:pacificClock(now),window:deadlineSummary({caseDueDates:['2026-10-27','2026-10-28'],taskDueDates:['2026-10-27','2026-10-28']},{daysAhead:0,includeOverdue:false},now)}));`;
  const results = ["UTC", "Asia/Tokyo", "America/New_York"].map((TZ) =>
    JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", program], {
        cwd: projectRoot,
        env: { ...process.env, TZ },
        encoding: "utf8",
      }),
    ),
  );
  for (const result of results) {
    assert.deepEqual(result, {
      day: "2026-10-27",
      clock: { day: "2026-10-27", time: "23:30" },
      window: {
        today: "2026-10-27",
        through: "2026-10-27",
        cases: 1,
        tasks: 1,
      },
    });
  }
  assert.equal(
    deadlineSummary(
      { caseDueDates: [], taskDueDates: [] },
      { daysAhead: 1, includeOverdue: false },
      new Date("2026-03-08T09:30:00Z"),
    ).through,
    "2026-03-09",
  );
});

async function reminderFixture(t, initialTime, time) {
  const localRoot = path.join(projectRoot, ".local");
  await mkdir(localRoot, { recursive: true });
  const directory = await mkdtemp(path.join(localRoot, "pacific-tests-"));
  t.after(() => {
    assert.ok(directory.startsWith(localRoot + path.sep));
    return rm(directory, { recursive: true, force: true });
  });
  let now = new Date(initialTime),
    calls = 0;
  const service = createReminderService({
    dataPath: path.join(directory, "reminders.json"),
    env: {
      RESEND_API_KEY: "test-key",
      REMINDER_EMAIL_FROM: "Karen's Load <test@example.com>",
    },
    now: () => now,
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200 };
    },
  });
  await service.save({
    config: {
      ...defaultConfig(),
      enabled: true,
      channels: ["email"],
      email: "recipient@example.com",
      time,
    },
    snapshot: {
      caseCount: 1,
      caseDueDates: [initialTime.slice(0, 10)],
      taskDueDates: [initialTime.slice(0, 10)],
    },
  });
  return {
    service,
    setTime: (value) => {
      now = new Date(value);
    },
    calls: () => calls,
  };
}

test("local reminders deduplicate by Pacific day across UTC midnight", async (t) => {
  const f = await reminderFixture(t, "2026-10-28T05:30:00Z", "09:00");
  await f.service.run();
  f.setTime("2026-10-28T06:30:00Z");
  assert.equal(
    (await f.service.run()).results.email.skipped,
    "already-attempted",
  );
  assert.equal(f.calls(), 1);
  f.setTime("2026-10-28T16:30:00Z");
  await f.service.run();
  assert.equal(f.calls(), 2);
});

test("local reminder scheduling handles the skipped and repeated Pacific DST hours", async (t) => {
  const spring = await reminderFixture(t, "2026-03-08T09:59:00Z", "02:30");
  assert.equal((await spring.service.run()).skipped, "before-time");
  spring.setTime("2026-03-08T10:00:00Z");
  await spring.service.run();
  assert.equal(spring.calls(), 1);
  const fall = await reminderFixture(t, "2026-11-01T08:30:00Z", "01:15");
  await fall.service.run();
  fall.setTime("2026-11-01T09:30:00Z");
  assert.equal(
    (await fall.service.run()).results.email.skipped,
    "already-attempted",
  );
  assert.equal(fall.calls(), 1);
});

test("reminder configuration sends Pacific time even when the browser reports another zone", async () => {
  const source = await readFile(
    new URL("../dist/reminder-client.js", import.meta.url),
    "utf8",
  );
  let sent;
  const root = {
    location: new URL("https://example.test/karen-scrum/"),
    localStorage: { getItem: () => null },
    fetch: async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ config: sent.config }));
    },
  };
  vm.runInNewContext(source, {
    window: root,
    URL,
    AbortSignal,
    Intl: {
      DateTimeFormat: () => ({
        resolvedOptions: () => ({ timeZone: "Asia/Tokyo" }),
      }),
    },
  });
  assert.equal(root.WWReminderClient.currentTimeZone(), "America/Los_Angeles");
  await root.WWReminderClient.request(
    "/api/reminders",
    "PUT",
    {
      config: defaultConfig(),
      snapshot: { caseCount: 0, caseDueDates: [], taskDueDates: [] },
    },
    { url: "https://service.example", token: "a".repeat(32) },
  );
  assert.equal(sent.timeZone, "America/Los_Angeles");
});

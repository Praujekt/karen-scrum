import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TIME_ZONE as BUSINESS_TIME_ZONE,
  zonedClock,
} from "./cloud-reminders/contracts.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
export const TIME_ZONE = BUSINESS_TIME_ZONE;
export function pacificClock(now = new Date()) {
  return zonedClock(now, TIME_ZONE);
}
export const defaultConfig = () => ({
  enabled: false,
  channels: [],
  email: "",
  phone: "",
  daysAhead: 3,
  time: "09:00",
  includeOverdue: true,
});
export class ReminderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function loadEnvironment(root = projectRoot) {
  try {
    process.loadEnvFile(path.join(root, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return process.env;
}
export function providerStatus(env) {
  return {
    email: Boolean(env.RESEND_API_KEY && env.REMINDER_EMAIL_FROM),
    sms: Boolean(
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER,
    ),
  };
}
export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value + "T12:00:00Z");
  return (
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value &&
    Number(value.slice(0, 4)) >= 1900
  );
}
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validatePayload(
  payload,
  env = {},
  { checkProviders = true } = {},
) {
  if (
    !plainObject(payload) ||
    !plainObject(payload.config) ||
    !plainObject(payload.snapshot)
  )
    throw new ReminderError(
      "A reminder configuration and deadline snapshot are required.",
    );
  const c = payload.config;
  if (
    typeof c.enabled !== "boolean" ||
    !Array.isArray(c.channels) ||
    c.channels.length > 2 ||
    new Set(c.channels).size !== c.channels.length ||
    c.channels.some((channel) => !["email", "sms"].includes(channel))
  )
    throw new ReminderError("Choose valid reminder channels.");
  if (
    typeof c.email !== "string" ||
    c.email.length > 254 ||
    typeof c.phone !== "string" ||
    c.phone.length > 20
  )
    throw new ReminderError("Enter a valid recipient.");
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))
    throw new ReminderError("Enter a valid email address.");
  if (c.phone && !/^\+[1-9]\d{7,14}$/.test(c.phone))
    throw new ReminderError(
      "Use an international phone number, such as +15551234567.",
    );
  if (
    !Number.isInteger(c.daysAhead) ||
    c.daysAhead < 0 ||
    c.daysAhead > 30 ||
    typeof c.time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.time) ||
    typeof c.includeOverdue !== "boolean"
  )
    throw new ReminderError(
      "Choose a reminder window of 0–30 days and a valid daily time.",
    );
  if (c.enabled && !c.channels.length)
    throw new ReminderError("Select email or SMS before enabling reminders.");
  const configured = providerStatus(env);
  for (const channel of c.channels) {
    if (c.enabled && checkProviders && !configured[channel])
      throw new ReminderError(
        `Set up the ${channel === "sms" ? "SMS" : "email"} provider in .env first.`,
      );
    if (c.enabled && !c[channel === "sms" ? "phone" : "email"])
      throw new ReminderError(
        `Enter your ${channel === "sms" ? "phone number" : "email address"}.`,
      );
  }
  const s = payload.snapshot;
  if (
    !Number.isInteger(s.caseCount) ||
    s.caseCount < 0 ||
    s.caseCount > 10000 ||
    !Array.isArray(s.caseDueDates) ||
    !Array.isArray(s.taskDueDates) ||
    s.caseDueDates.length > 10000 ||
    s.taskDueDates.length > 100000 ||
    s.caseDueDates.some((d) => !validDate(d)) ||
    s.taskDueDates.some((d) => !validDate(d))
  )
    throw new ReminderError(
      "The deadline snapshot contains invalid dates or too many records.",
    );
  if (s.caseDueDates.length !== s.caseCount)
    throw new ReminderError(
      "The active case count does not match its deadlines.",
    );
  // Deliberately construct new objects: names, notes, titles and unknown fields never reach disk.
  return {
    config: {
      enabled: c.enabled,
      channels: [...c.channels],
      email: c.email.trim(),
      phone: c.phone.trim(),
      daysAhead: c.daysAhead,
      time: c.time,
      includeOverdue: c.includeOverdue,
    },
    snapshot: {
      caseCount: s.caseCount,
      caseDueDates: [...s.caseDueDates],
      taskDueDates: [...s.taskDueDates],
    },
  };
}
export function deadlineSummary(snapshot, config, now = new Date()) {
  const today = pacificClock(now).day,
    end = new Date(today + "T12:00:00Z");
  end.setUTCDate(end.getUTCDate() + config.daysAhead);
  const through = end.toISOString().slice(0, 10);
  const count = (dates) =>
    dates.filter(
      (date) => date <= through && (config.includeOverdue || date >= today),
    ).length;
  return {
    today,
    through,
    cases: count(snapshot.caseDueDates),
    tasks: count(snapshot.taskDueDates),
  };
}
function newState() {
  return {
    config: defaultConfig(),
    snapshot: { caseCount: 0, caseDueDates: [], taskDueDates: [] },
    snapshotUpdatedAt: null,
    lastRun: null,
    lastError: null,
    lastSent: {},
    delivery: {},
  };
}
async function atomicWrite(filename, data) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function createReminderService({
  dataPath = path.join(projectRoot, ".local", "reminders.json"),
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  let running = false;
  async function readState() {
    try {
      const raw = JSON.parse(await readFile(dataPath, "utf8"));
      // Missing credentials must not hide previously saved preferences. Validate
      // the complete shape here; provider checks still apply on writes and sends.
      const clean = validatePayload(raw, {}, { checkProviders: false });
      return { ...newState(), ...raw, ...clean };
    } catch (error) {
      if (error.code === "ENOENT") return newState();
      throw new ReminderError(
        "The local reminder file could not be read. Restore it or rename it before continuing.",
        500,
      );
    }
  }
  async function locked(work) {
    if (running)
      throw new ReminderError(
        "Reminders are already being updated. Try again shortly.",
        409,
      );
    running = true;
    const lockPath = dataPath + ".lock";
    let lock;
    try {
      await mkdir(path.dirname(dataPath), { recursive: true });
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age < 5 * 60 * 1000)
          throw new ReminderError(
            "Another reminder check is running. Try again shortly.",
            409,
          );
        await unlink(lockPath);
        lock = await open(lockPath, "wx", 0o600);
      }
      return await work();
    } finally {
      if (lock) {
        await lock.close();
        await unlink(lockPath).catch(() => {});
      }
      running = false;
    }
  }
  function publicStatus(state) {
    return {
      available: true,
      configured: providerStatus(env),
      config: state.config,
      lastRun: state.lastRun,
      lastError: state.lastError,
      lastSent: state.lastSent,
      snapshotUpdatedAt: state.snapshotUpdatedAt,
    };
  }
  async function send(channel, config, text, idempotencyKey) {
    const configured = providerStatus(env);
    if (!configured[channel])
      throw new ReminderError(
        `${channel === "sms" ? "SMS" : "Email"} provider is not configured.`,
      );
    let response;
    if (channel === "email") {
      if (!config.email)
        throw new ReminderError("Enter a recipient email address.");
      response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          from: env.REMINDER_EMAIL_FROM,
          to: [config.email],
          subject: "Karen's Load · Your deadline reminder",
          text,
        }),
        signal: AbortSignal.timeout(20000),
      });
    } else {
      if (!config.phone)
        throw new ReminderError("Enter a recipient phone number.");
      response = await fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(
                `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
              ).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: config.phone,
            From: env.TWILIO_FROM_NUMBER,
            Body: text,
          }).toString(),
          signal: AbortSignal.timeout(20000),
        },
      );
    }
    if (!response.ok)
      throw new ReminderError(
        `${channel === "sms" ? "SMS" : "Email"} provider rejected the message (HTTP ${response.status}). Check its dashboard and .env settings.`,
      );
    // Accepted by a provider is not a delivery receipt.
    return { accepted: true };
  }
  return {
    async getStatus() {
      return publicStatus(await readState());
    },
    async save(payload) {
      const clean = validatePayload(payload, env);
      return locked(async () => {
        const state = await readState();
        Object.assign(state, clean, { snapshotUpdatedAt: now().toISOString() });
        await atomicWrite(dataPath, state);
        return publicStatus(state);
      });
    },
    async syncSnapshot(snapshot) {
      return locked(async () => {
        const state = await readState();
        // A routine date update must not overwrite recipient preferences from a
        // newer tab, or fail simply because provider credentials were removed.
        const clean = validatePayload(
          { config: state.config, snapshot },
          {},
          { checkProviders: false },
        );
        state.snapshot = clean.snapshot;
        state.snapshotUpdatedAt = now().toISOString();
        await atomicWrite(dataPath, state);
        return publicStatus(state);
      });
    },
    async run({ test = false } = {}) {
      return locked(async () => {
        const state = await readState(),
          current = now(),
          clock = pacificClock(current);
        if (!test && !state.config.enabled) return { skipped: "disabled" };
        const summary = deadlineSummary(state.snapshot, state.config, current);
        if (!test && clock.time < state.config.time)
          return { skipped: "before-time" };
        if (test && !state.config.channels.length)
          throw new ReminderError(
            "Select a channel and save reminder settings first.",
          );
        if (!test && !summary.cases && !summary.tasks) {
          state.lastRun = current.toISOString();
          state.lastError = null;
          await atomicWrite(dataPath, state);
          return { skipped: "no-deadlines" };
        }
        const text = test
          ? "Karen's Load test reminder. Your reminder connection is working. No patient information is included."
          : `Karen's Load reminder: ${summary.tasks} unfinished task${summary.tasks === 1 ? "" : "s"} and ${summary.cases} active case deadline${summary.cases === 1 ? "" : "s"} due through ${summary.through}${state.config.includeOverdue ? ", including overdue work" : ""}. Open Karen's Load on your laptop to review. No patient information is included.`;
        const results = {};
        state.lastRun = current.toISOString();
        const errors = [];
        for (const channel of state.config.channels) {
          const previous = state.delivery[channel];
          if (!test && previous?.date === summary.today) {
            if (
              previous.status === "accepted" ||
              channel === "sms" ||
              current.valueOf() - Date.parse(previous.at) < 15 * 60 * 1000
            ) {
              results[channel] = { skipped: "already-attempted" };
              if (previous.error) errors.push(previous.error);
              continue;
            }
          }
          // Record the SMS attempt before calling the provider. A timeout may still mean it sent;
          // automatic SMS retries would risk duplicate messages and charges.
          if (!test) {
            state.delivery[channel] = {
              date: summary.today,
              at: current.toISOString(),
              status: "attempted",
            };
            await atomicWrite(dataPath, state);
          }
          const digest = createHash("sha256")
            .update(`${summary.today}|${channel}|${state.config.email}|${text}`)
            .digest("hex")
            .slice(0, 40);
          try {
            results[channel] = await send(
              channel,
              state.config,
              text,
              test ? `weekwise-test-${randomUUID()}` : `weekwise-${digest}`,
            );
            if (!test) {
              state.delivery[channel].status = "accepted";
              state.lastSent[channel] = current.toISOString();
            }
          } catch (error) {
            const message =
              error instanceof ReminderError
                ? error.message
                : `${channel === "sms" ? "SMS" : "Email"} could not reach the provider. Check your connection and provider dashboard.`;
            results[channel] = { accepted: false, error: message };
            errors.push(message);
            if (!test) {
              state.delivery[channel].status = "failed";
              state.delivery[channel].error = message;
            }
          }
          await atomicWrite(dataPath, state);
        }
        state.lastError = errors.length ? errors.join(" ") : null;
        await atomicWrite(dataPath, state);
        if (test && Object.values(results).some((result) => result.error))
          throw new ReminderError(state.lastError, 502);
        return { results, status: publicStatus(state) };
      });
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv.includes("--reminders-once")) {
    console.error(
      "Run with --reminders-once to check scheduled reminders once.",
    );
    process.exitCode = 1;
  } else {
    try {
      loadEnvironment();
      const result = await createReminderService().run();
      console.log(JSON.stringify(result));
      if (result.status?.lastError) process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

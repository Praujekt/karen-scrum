export const TIME_ZONE = "America/Los_Angeles";

export class CloudReminderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
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
export const defaultSnapshot = () => ({
  caseCount: 0,
  caseDueDates: [],
  taskDueDates: [],
});
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
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
export function providerStatus(env) {
  return {
    email: Boolean(env.RESEND_API_KEY && env.REMINDER_EMAIL_FROM),
    sms: Boolean(
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER,
    ),
  };
}
export function validateSnapshot(value) {
  if (
    !object(value) ||
    !Number.isInteger(value.caseCount) ||
    value.caseCount < 0 ||
    value.caseCount > 10000 ||
    !Array.isArray(value.caseDueDates) ||
    !Array.isArray(value.taskDueDates) ||
    value.caseDueDates.length !== value.caseCount ||
    value.caseDueDates.length > 10000 ||
    value.taskDueDates.length > 50000 ||
    value.caseDueDates.some((date) => !validDate(date)) ||
    value.taskDueDates.some((date) => !validDate(date))
  )
    throw new CloudReminderError(
      "The deadline snapshot contains invalid counts or dates (maximum 10,000 cases and 50,000 task deadlines).",
    );
  // Construct a fresh allowlist; patient names, notes and task titles are discarded.
  return {
    caseCount: value.caseCount,
    caseDueDates: [...value.caseDueDates],
    taskDueDates: [...value.taskDueDates],
  };
}
export function validateConfig(
  value,
  env = {},
  { checkProviders = true } = {},
) {
  if (
    !object(value) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.channels) ||
    value.channels.length > 2 ||
    new Set(value.channels).size !== value.channels.length ||
    value.channels.some((channel) => !["email", "sms"].includes(channel))
  )
    throw new CloudReminderError("Choose valid reminder channels.");
  if (
    typeof value.email !== "string" ||
    value.email.length > 254 ||
    typeof value.phone !== "string" ||
    value.phone.length > 20
  )
    throw new CloudReminderError("Enter a valid recipient.");
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email))
    throw new CloudReminderError("Enter a valid email address.");
  if (value.phone && !/^\+[1-9]\d{7,14}$/.test(value.phone))
    throw new CloudReminderError(
      "Use an international phone number, such as +15551234567.",
    );
  if (
    !Number.isInteger(value.daysAhead) ||
    value.daysAhead < 0 ||
    value.daysAhead > 30 ||
    typeof value.time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
    typeof value.includeOverdue !== "boolean"
  )
    throw new CloudReminderError(
      "Choose a reminder window of 0–30 days and a valid daily time.",
    );
  if (value.enabled && !value.channels.length)
    throw new CloudReminderError(
      "Select email or SMS before enabling reminders.",
    );
  const configured = providerStatus(env);
  for (const channel of value.channels) {
    if (value.enabled && checkProviders && !configured[channel])
      throw new CloudReminderError(
        `Set up the ${channel === "sms" ? "SMS" : "email"} provider in Cloudflare secrets first.`,
      );
    if (value.enabled && !value[channel === "sms" ? "phone" : "email"])
      throw new CloudReminderError(
        `Enter your ${channel === "sms" ? "phone number" : "email address"}.`,
      );
  }
  return {
    enabled: value.enabled,
    channels: [...value.channels],
    email: value.email,
    phone: value.phone,
    daysAhead: value.daysAhead,
    time: value.time,
    includeOverdue: value.includeOverdue,
  };
}
export function validateTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length > 100)
    throw new CloudReminderError("Choose a valid IANA time zone.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new CloudReminderError("Choose a valid IANA time zone.");
  }
  return timeZone;
}
export function zonedClock(now, timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
export function deadlineSummary(snapshot, config, day) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + config.daysAhead);
  const through = date.toISOString().slice(0, 10);
  const count = (dates) =>
    dates.filter(
      (value) => value <= through && (config.includeOverdue || value >= day),
    ).length;
  return {
    day,
    through,
    cases: count(snapshot.caseDueDates),
    tasks: count(snapshot.taskDueDates),
  };
}

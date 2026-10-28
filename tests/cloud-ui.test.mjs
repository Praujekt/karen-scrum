/** Real browser integration against a completely mocked cloud reminder service. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWeekwiseServer } from "../server.mjs";
import { createReminderService, defaultConfig } from "../reminder-service.mjs";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  try {
    ({ chromium } = require("../.qa-tools/node_modules/playwright"));
  } catch {}
}

test(
  "cloud reminders authenticate, redact snapshots, recover, and pause before disconnecting",
  {
    skip: !chromium ? "Optional Playwright library is not installed." : false,
    timeout: 120000,
  },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "weekwise-cloud-ui-"));
    const service = createReminderService({
      dataPath: path.join(scratch, "reminders.json"),
      env: {
        RESEND_API_KEY: "test-only-never-sent",
        REMINDER_EMAIL_FROM: "test@example.com",
      },
      fetchImpl: async () => {
        throw Error("No provider network calls in browser tests.");
      },
    });
    await service.save({
      config: {
        ...defaultConfig(),
        enabled: true,
        channels: ["email"],
        email: "local@example.com",
      },
      snapshot: { caseCount: 0, caseDueDates: [], taskDueDates: [] },
    });
    const server = createWeekwiseServer({ service });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(scratch, { recursive: true, force: true });
    });
    browser = await chromium.launch(
      process.env.WEEKWISE_BROWSER_EXECUTABLE
        ? {
            executablePath: process.env.WEEKWISE_BROWSER_EXECUTABLE,
            headless: true,
          }
        : { channel: "chrome", headless: true },
    );
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      timezoneId: "America/Los_Angeles",
      acceptDownloads: true,
    });
    const page = await context.newPage(),
      origin = "http://127.0.0.1:" + server.address().port;
    const cloudUrl = "https://reminders.example.workers.dev",
      token = "weekwise-test-connection-token-0123456789";
    const requests = [],
      unexpected = [],
      errors = [],
      localRequests = [];
    let offline = false,
      rejectDisable = false,
      savedAtDisable = null;
    const remote = {
      available: true,
      mode: "cloud",
      configured: { email: true, sms: false },
      config: defaultConfig(),
      timeZone: "UTC",
      lastRun: null,
      lastError: null,
      lastSent: {},
      snapshotUpdatedAt: null,
    };
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().startsWith(origin + "/api/"))
        localRequests.push(request.url());
    });
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.origin !== cloudUrl) {
        unexpected.push(url.href);
        return route.abort();
      }
      const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, X-Weekwise-Request",
        "Content-Type": "application/json",
      };
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers, body: "" });
      const body = request.postData() ? JSON.parse(request.postData()) : null;
      requests.push({
        path: url.pathname,
        method: request.method(),
        headers: await request.allHeaders(),
        body,
      });
      if (offline) return route.abort("connectionfailed");
      if (url.pathname === "/config") {
        if (body.config.enabled === false && rejectDisable)
          return route.fulfill({
            status: 503,
            headers,
            body: JSON.stringify({
              error: "The schedule could not be paused.",
            }),
          });
        if (body.config.enabled === false)
          savedAtDisable = await page.evaluate(() =>
            localStorage.getItem(WWReminderClient.storageKey),
          );
        remote.config = body.config;
        remote.timeZone = body.timeZone;
      }
      if (body?.snapshot) remote.snapshotUpdatedAt = new Date().toISOString();
      const result =
        url.pathname === "/test"
          ? { results: { email: { accepted: true } }, status: remote }
          : remote;
      return route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify(result),
      });
    });
    await page.goto(origin);
    await page.getByRole("button", { name: "New case", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Patient name", { exact: false })
      .fill("Private patient name");
    await dialog
      .getByLabel("Initial note", { exact: false })
      .fill("Private narrative must stay on this device.");
    await dialog
      .getByRole("button", { name: "Create case", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Private patient name", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Reminders & settings", exact: true })
      .click();
    assert.equal(
      requests.length,
      0,
      "No external service is contacted before an explicit connection.",
    );
    await page
      .getByRole("button", { name: "Connect cloud reminders", exact: true })
      .click();
    await dialog
      .getByLabel("Service URL")
      .fill("http://reminders.example.workers.dev");
    await dialog.getByLabel("Connection token").fill(token);
    await dialog
      .getByRole("button", { name: "Connect service", exact: true })
      .click();
    await dialog
      .getByRole("alert")
      .getByText(/HTTPS service origin/)
      .waitFor();
    assert.equal(requests.length, 0);
    await dialog.getByLabel("Service URL").fill(cloudUrl + "/status?token=no");
    await dialog
      .getByRole("button", { name: "Connect service", exact: true })
      .click();
    await dialog
      .getByRole("alert")
      .getByText(/without a path/)
      .waitFor();
    assert.equal(requests.length, 0);
    await dialog.getByLabel("Service URL").fill(cloudUrl);
    await dialog
      .getByRole("button", { name: "Connect service", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("Cloud connected", { exact: true }).waitFor();
    assert.equal(
      (await service.getStatus()).config.enabled,
      false,
      "Connecting cloud pauses the local schedule.",
    );
    const saved = await page.evaluate(() =>
      localStorage.getItem(WWReminderClient.storageKey),
    );
    assert.equal(JSON.parse(saved).token, token);
    assert.equal(JSON.parse(saved).url, cloudUrl);
    const initialConfig = requests.find(
      (request) => request.path === "/config",
    );
    assert.equal(initialConfig.body.timeZone, "America/Los_Angeles");
    assert.equal(
      initialConfig.body.snapshot.caseCount,
      1,
      "Fictional examples are excluded from reminders.",
    );
    assert.deepEqual(Object.keys(initialConfig.body.snapshot).sort(), [
      "caseCount",
      "caseDueDates",
      "taskDueDates",
    ]);
    for (const request of requests) {
      assert.equal(request.headers.authorization, "Bearer " + token);
      assert.ok(!JSON.stringify(request.body).includes("Private patient"));
      assert.ok(!JSON.stringify(request.body).includes("Private narrative"));
    }
    await page.getByLabel("Enable daily reminders").check();
    await page.getByLabel("Email reminders", { exact: false }).check();
    await page
      .getByLabel("Reminder email address")
      .fill("recipient@example.com");
    await page.getByLabel("Daily send time").fill("10:45");
    await page
      .getByRole("button", { name: "Save reminders", exact: true })
      .click();
    await page
      .getByRole("status")
      .getByText("Daily reminders enabled.", { exact: true })
      .waitFor();
    assert.equal(remote.config.enabled, true);
    assert.equal(remote.timeZone, "America/Los_Angeles");
    await page
      .getByRole("button", { name: "Send test reminder", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Send test", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.ok(
      requests.some(
        (request) => request.path === "/test" && request.method === "POST",
      ),
    );
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download backup", exact: true })
      .click();
    const backupText = await readFile(await (await download).path(), "utf8");
    assert.ok(
      !backupText.includes(token),
      "Case backups exclude the connection token.",
    );
    assert.ok(
      !backupText.includes(cloudUrl),
      "Case backups exclude the connection URL.",
    );
    const localCount = localRequests.length;
    offline = true;
    await page.reload();
    await page
      .locator(".cloud-error")
      .getByText(/could not be reached/)
      .waitFor();
    assert.equal(
      localRequests.length,
      localCount,
      "Cloud failure does not silently switch to local reminders.",
    );
    await page
      .getByRole("button", { name: "All cases", exact: false })
      .first()
      .click();
    await page
      .locator(".case-card")
      .filter({ hasText: "Private patient name" })
      .click();
    await page.locator("[data-task-check]").first().check();
    await page.waitForFunction(
      async () =>
        (await WWStore.getCases()).find(
          (c) => c.name === "Private patient name",
        ).tasks[0].done,
    );
    await page
      .getByRole("button", { name: "Reminders & settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Disconnect cloud reminders", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Disconnect service", exact: true })
      .click();
    await dialog
      .getByRole("alert")
      .getByText(/could not be reached/)
      .waitFor();
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem(WWReminderClient.storageKey),
      ),
      saved,
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: /Clear workspace/ }).click();
    await dialog
      .getByRole("button", { name: "Clear everything", exact: true })
      .click();
    await dialog
      .getByRole("alert")
      .getByText(/could not be reached/)
      .waitFor();
    assert.ok(
      (await page.evaluate(() => WWStore.getCases())).some(
        (c) => c.name === "Private patient name",
      ),
      "Cloud pause failure blocks destructive clearing.",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    offline = false;
    await page
      .getByRole("button", { name: "Retry connection", exact: true })
      .click();
    await page
      .getByRole("status")
      .getByText(/connection refreshed/)
      .waitFor();
    rejectDisable = true;
    await page
      .getByRole("button", { name: "Disconnect cloud reminders", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Disconnect service", exact: true })
      .click();
    await dialog
      .getByRole("alert")
      .getByText("The schedule could not be paused.", { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem(WWReminderClient.storageKey),
      ),
      saved,
    );
    assert.equal(remote.config.enabled, true);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    rejectDisable = false;
    await page
      .getByRole("button", { name: "Disconnect cloud reminders", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Disconnect service", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "Connect cloud reminders", exact: true })
      .waitFor();
    assert.equal(remote.config.enabled, false);
    assert.equal(
      JSON.parse(savedAtDisable).token,
      token,
      "Token is still available when the service is paused.",
    );
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem(WWReminderClient.storageKey),
      ),
      null,
    );
    assert.ok(
      (await page.evaluate(() => WWStore.getCases())).some(
        (c) => c.name === "Private patient name",
      ),
    );
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  },
);

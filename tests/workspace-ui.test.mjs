/** UI-level phone/laptop sync, real WebCrypto, mocked service; no real network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWeekwiseServer } from "../server.mjs";
import { createReminderService } from "../reminder-service.mjs";
const require = createRequire(import.meta.url);
const browserExecutable =
  process.env.KARENS_LOAD_BROWSER_EXECUTABLE ||
  process.env.WEEKWISE_BROWSER_EXECUTABLE;
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  try {
    ({ chromium } = require("../.qa-tools/node_modules/playwright"));
  } catch {}
}

test(
  "shared workspace UI syncs records/evidence between devices, locks, and rolls back failed saves",
  {
    skip: !chromium ? "Optional Playwright library is not installed." : false,
    timeout: 120000,
  },
  async (t) => {
    const scratch = await mkdtemp(
      path.join(os.tmpdir(), "weekwise-workspace-ui-"),
    );
    const server = createWeekwiseServer({
      service: createReminderService({
        dataPath: path.join(scratch, "reminders.json"),
        env: {},
        fetchImpl: async () => {
          throw Error("No provider calls in tests.");
        },
      }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(scratch, { recursive: true, force: true });
    });
    browser = await chromium.launch(
      browserExecutable
        ? {
            executablePath: browserExecutable,
            headless: true,
          }
        : { channel: "chrome", headless: true },
    );
    const origin = "http://127.0.0.1:" + server.address().port,
      workspaceUrl = "https://workspace.example.workers.dev";
    const token = "private-workspace-access-key-0123456789",
      passphrase = "A private shared passphrase for testing";
    const googleToken =
      "a".repeat(35) + "." + "b".repeat(35) + "." + "c".repeat(35);
    const remote = { version: 0, payload: null, updatedAt: null },
      files = new Map(),
      cloudRequests = [],
      unexpected = [],
      errors = [];
    const delivery = {
      available: true,
      mode: "cloud",
      configured: { email: true, sms: false },
      config: {
        enabled: false,
        channels: [],
        email: "",
        phone: "",
        daysAhead: 3,
        time: "09:00",
        includeOverdue: true,
      },
      timeZone: "America/Los_Angeles",
      lastRun: null,
      lastError: null,
      lastSent: {},
      snapshotUpdatedAt: null,
    };
    let rejectWrites = false,
      offline = false;
    async function device() {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        timezoneId: "America/Los_Angeles",
        acceptDownloads: true,
      });
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== workspaceUrl) {
          unexpected.push(url.href);
          return route.abort();
        }
        const headers = {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
          "Access-Control-Allow-Headers":
            "Authorization, Content-Type, X-Weekwise-Request",
        };
        const json = (status, value) =>
          route.fulfill({
            status,
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(value),
          });
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers, body: "" });
        const authorization = (await request.allHeaders()).authorization;
        assert.ok(
          [token, googleToken].some(
            (value) => authorization === "Bearer " + value,
          ),
        );
        cloudRequests.push({
          path: url.pathname,
          method: request.method(),
          body: request.postDataBuffer(),
        });
        if (offline) return route.abort("connectionfailed");
        if (["/status", "/config", "/snapshot"].includes(url.pathname)) {
          const body = request.postData()
            ? JSON.parse(request.postData())
            : null;
          if (body?.snapshot && body.workspaceVersion !== remote.version)
            return json(409, {
              error: "Refresh the shared workspace first.",
              version: remote.version,
            });
          if (body?.config) {
            delivery.config = body.config;
            delivery.timeZone = body.timeZone;
          }
          if (body?.snapshot)
            delivery.snapshotUpdatedAt = new Date().toISOString();
          return json(200, delivery);
        }
        if (url.pathname === "/workspace") {
          if (request.method() === "GET") return json(200, remote);
          if (rejectWrites)
            return json(503, { error: "Shared save rejected." });
          const data = JSON.parse(request.postData());
          if (data.expectedVersion !== remote.version)
            return json(409, { version: remote.version });
          remote.version++;
          remote.payload = data.payload;
          remote.updatedAt = new Date().toISOString();
          return json(200, {
            version: remote.version,
            updatedAt: remote.updatedAt,
          });
        }
        if (url.pathname.startsWith("/files/")) {
          if (request.method() === "PUT") {
            files.set(url.pathname, request.postDataBuffer());
            return json(200, { saved: true });
          }
          return route.fulfill({
            status: files.has(url.pathname) ? 200 : 404,
            headers: { ...headers, "Content-Type": "application/octet-stream" },
            body: files.get(url.pathname) || Buffer.from(""),
          });
        }
        return json(404, { error: "Unknown test endpoint." });
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await page
        .getByRole("button", { name: "New Case", exact: true })
        .waitFor();
      return { context, page };
    }
    async function connect(page, google = false) {
      await page
        .getByRole("button", { name: "Reminders & Settings", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Connect Shared Workspace", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Workspace URL", { exact: true })
        .fill(workspaceUrl);
      if (google) {
        await page.evaluate((value) => {
          window.googleCalls = [];
          WWGoogle.signIn = async (clientId) => {
            googleCalls.push(clientId);
            return value;
          };
        }, googleToken);
        await dialog.getByLabel("Sign-In Method").selectOption("google");
        await dialog
          .getByLabel("Google Client ID")
          .fill("123456789012-testclient.apps.googleusercontent.com");
      } else await dialog.getByLabel("Workspace Access Key").fill(token);
      await dialog.getByLabel("Encryption Passphrase").fill(passphrase);
      await dialog
        .getByRole("button", { name: "Connect Workspace", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await page.locator(".workspace-sync-banner").waitFor();
    }
    const first = await device(),
      p1 = first.page,
      d1 = p1.getByRole("dialog");
    await p1
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await d1
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await d1.waitFor({ state: "hidden" });
    await p1.getByRole("button", { name: "New Case", exact: true }).click();
    await d1
      .getByLabel("Patient Name", { exact: false })
      .fill("Private Shared Patient");
    await d1
      .getByLabel("Initial Note", { exact: false })
      .fill("Private initial shared note");
    await d1.getByRole("button", { name: "Create Case", exact: true }).click();
    await p1
      .getByRole("heading", { name: "Private Shared Patient", exact: true })
      .waitFor();
    await p1.getByRole("tab", { name: /^Evidence/ }).click();
    const evidence = Buffer.from("Private scanned form content\n");
    await p1.locator("#evidence-files").setInputFiles({
      name: "private-scan.txt",
      mimeType: "text/plain",
      buffer: evidence,
    });
    await p1
      .getByRole("heading", { name: "private-scan.txt", exact: true })
      .waitFor();
    for (const [name, kind, value] of [
      ["Signed original", "paper", "Office cabinet B, folder 4"],
      [
        "Drive report",
        "drive",
        "https://docs.google.com/document/d/example/edit",
      ],
    ]) {
      await p1
        .getByRole("button", { name: "Add Document Reference", exact: true })
        .click();
      await d1.getByLabel("Document Name").fill(name);
      await d1.getByLabel("Reference Type").selectOption(kind);
      await d1.getByLabel("File Path or Document URL").fill(value);
      await d1
        .getByRole("button", { name: "Add Reference", exact: true })
        .click();
      await p1.getByRole("heading", { name, exact: true }).waitFor();
    }
    assert.equal(
      await p1
        .getByRole("button", { name: "Copy Location", exact: true })
        .count(),
      1,
    );
    assert.equal(
      cloudRequests.length,
      0,
      "No shared service is contacted until explicitly connected.",
    );
    await connect(p1);
    assert.equal(remote.version, 1);
    assert.ok(!JSON.stringify(remote).includes("Private Shared Patient"));
    assert.ok(!JSON.stringify(remote).includes("private-scan.txt"));
    assert.ok(files.size > 0);
    assert.ok([...files.values()].every((value) => !value.includes(evidence)));

    const second = await device(),
      p2 = second.page;
    await connect(p2);
    assert.equal(
      await p2.locator(".case-card").count(),
      1,
      "Second device replaces examples with the same shared records.",
    );
    await p1
      .locator(".case-card")
      .filter({ hasText: "Private Shared Patient" })
      .click();
    await p1.locator("[data-task-check]").first().check();
    await p1.waitForFunction(
      async () =>
        (await WWStore.getCases()).find(
          (c) => c.name === "Private Shared Patient",
        ).tasks[0].done,
    );
    await p1.getByRole("button", { name: "Edit Case", exact: true }).click();
    await d1.getByLabel("Patient Name", { exact: false }).waitFor();
    await p2
      .getByRole("button", { name: "Refresh Shared Workspace", exact: true })
      .click();
    await p2
      .getByRole("status")
      .getByText("Shared workspace refreshed.", { exact: true })
      .waitFor();
    await p2
      .locator(".case-card")
      .filter({ hasText: "Private Shared Patient" })
      .click();
    await p2
      .getByRole("heading", { name: "Private Shared Patient", exact: true })
      .waitFor();
    assert.equal(await p2.locator("[data-task-check]:checked").count(), 1);
    await p2.getByRole("tab", { name: /^Notes/ }).click();
    await p2.getByLabel("Add a Case Note").fill("Note added from the phone");
    await p2.getByRole("button", { name: "Add Note", exact: true }).click();
    await p2.getByText("Note added from the phone", { exact: true }).waitFor();
    await p2
      .getByRole("status")
      .getByText("Note added.", { exact: true })
      .waitFor();
    await d1
      .getByLabel("Patient Name", { exact: false })
      .fill("Renamed Shared Patient");
    await d1.getByRole("button", { name: "Save Case", exact: true }).click();
    await d1
      .getByRole("alert")
      .getByText(/changed on another device/)
      .waitFor();
    await d1.getByRole("button", { name: "Cancel", exact: true }).click();
    await p1.getByRole("button", { name: "Edit Case", exact: true }).click();
    await d1
      .getByLabel("Patient Name", { exact: false })
      .fill("Renamed Shared Patient");
    await d1.getByRole("button", { name: "Save Case", exact: true }).click();
    await d1.waitFor({ state: "hidden" });
    await p1
      .getByRole("heading", { name: "Renamed Shared Patient", exact: true })
      .waitFor();
    await p1.getByRole("tab", { name: /^Notes/ }).click();
    await p1.getByText("Note added from the phone", { exact: true }).waitFor();
    await p2
      .getByRole("button", { name: "Refresh Shared Workspace", exact: true })
      .click();
    await p2
      .getByRole("status")
      .getByText("Shared workspace refreshed.", { exact: true })
      .waitFor();
    await p2
      .getByRole("heading", { name: "Renamed Shared Patient", exact: true })
      .waitFor();
    await p2.getByRole("tab", { name: /^Evidence/ }).click();
    const download = p2.waitForEvent("download");
    await p2.getByRole("button", { name: "Download", exact: true }).click();
    assert.deepEqual(
      await readFile(await (await download).path()),
      evidence,
      "Evidence decrypts on the other device.",
    );
    await p2
      .getByText("Paper location · Office cabinet B, folder 4", { exact: true })
      .waitFor();

    await p1.reload();
    await p1
      .getByRole("heading", { name: "Unlock Your Workspace", exact: true })
      .waitFor();
    assert.ok(
      !(await p1.locator("#app").innerText()).includes(
        "Renamed Shared Patient",
      ),
    );
    assert.equal(
      await p1.getByRole("button", { name: "New Case", exact: true }).count(),
      0,
    );
    await p1
      .getByRole("button", { name: "Unlock Shared Workspace", exact: true })
      .click();
    await d1
      .getByLabel("Encryption Passphrase")
      .fill("A wrong passphrase for testing");
    await d1
      .getByRole("button", { name: "Unlock Workspace", exact: true })
      .click();
    await d1
      .getByRole("alert")
      .getByText(/did not unlock/)
      .waitFor();
    assert.ok(
      !(await p1.locator("#app").innerText()).includes(
        "Renamed Shared Patient",
      ),
    );
    await d1.getByLabel("Encryption Passphrase").fill(passphrase);
    await d1
      .getByRole("button", { name: "Unlock Workspace", exact: true })
      .click();
    await d1.waitFor({ state: "hidden" });
    await p1
      .locator(".case-card")
      .filter({ hasText: "Renamed Shared Patient" })
      .click();
    await p1.getByRole("tab", { name: /^Notes/ }).click();
    const beforeRejected = remote.version;
    rejectWrites = true;
    await p1
      .getByLabel("Add a Case Note")
      .fill("This failed note must not persist");
    await p1.getByRole("button", { name: "Add Note", exact: true }).click();
    await p1
      .getByRole("status")
      .getByText("Shared save rejected.", { exact: true })
      .waitFor();
    assert.equal(remote.version, beforeRejected);
    assert.equal(
      await p1.getByLabel("Add a Case Note").inputValue(),
      "This failed note must not persist",
      "Rejected saves retain the typed note draft.",
    );
    assert.ok(
      !(await p1.evaluate(() => WWStore.getCases())).some((c) =>
        c.notes.some((n) => n.text === "This failed note must not persist"),
      ),
    );
    rejectWrites = false;
    await p1
      .getByRole("button", { name: "Refresh Shared Workspace", exact: true })
      .click();
    await p1
      .getByRole("status")
      .getByText("Shared workspace refreshed.", { exact: true })
      .waitFor();
    await p1.getByLabel("Add a Case Note").fill("Recovered save after refresh");
    await p1.getByRole("button", { name: "Add Note", exact: true }).click();
    await p1
      .getByRole("status")
      .getByText("Note added.", { exact: true })
      .waitFor();
    assert.equal(remote.version, beforeRejected + 1);
    const versionBeforeBackup = remote.version;
    offline = true;
    await p1
      .getByRole("button", { name: /^All Cases/ })
      .first()
      .click();
    await p1
      .locator(".case-card")
      .filter({ hasText: "Renamed Shared Patient" })
      .waitFor();
    await p1
      .getByRole("button", { name: "Reminders & Settings", exact: true })
      .click();
    const cachedBackup = p1.waitForEvent("download");
    await p1
      .getByRole("button", { name: "Download Backup", exact: true })
      .click();
    const cachedData = JSON.parse(
      await readFile(await (await cachedBackup).path(), "utf8"),
    );
    assert.equal(
      cachedData.cases[0].name,
      "Renamed Shared Patient",
      "Cached backups remain available during an outage.",
    );
    assert.equal(cachedData.files.length, 1);
    assert.equal(
      remote.version,
      versionBeforeBackup,
      "Downloading a backup never writes a new shared version.",
    );
    offline = false;

    const third = await device(),
      p3 = third.page;
    await connect(p3, true);
    assert.deepEqual(await p3.evaluate(() => googleCalls), [
      "123456789012-testclient.apps.googleusercontent.com",
    ]);
    const stored = await p3.evaluate(() =>
      Object.values(localStorage).join(""),
    );
    assert.ok(
      !stored.includes(googleToken),
      "Google session tokens are not persisted in localStorage.",
    );
    assert.ok(
      !stored.includes(passphrase),
      "Encryption passphrases are never persisted.",
    );
    await p2
      .getByRole("button", { name: "Reminders & Settings", exact: true })
      .click();
    await p2.getByLabel("Reminder Email Address").fill("shared@example.com");
    await p2.getByLabel("Email Reminders", { exact: false }).check();
    await p2.getByLabel("Enable Daily Reminders").check();
    await p2
      .getByRole("button", { name: "Save Reminders", exact: true })
      .click();
    await p2
      .getByRole("status")
      .getByText("Daily reminders enabled.", { exact: true })
      .waitFor();
    const preferenceSave = cloudRequests
      .filter((request) => request.path === "/config")
      .at(-1);
    assert.equal(
      JSON.parse(preferenceSave.body.toString()).workspaceVersion,
      remote.version,
      "Unified reminder preferences carry the current shared version.",
    );
    assert.equal(
      await p2
        .getByRole("button", {
          name: "Disconnect Cloud Reminders",
          exact: true,
        })
        .count(),
      0,
      "Shared reminders use the workspace sign-in without a second connection.",
    );
    await p2
      .getByRole("button", { name: "Disconnect This Browser", exact: true })
      .click();
    await p2
      .getByRole("dialog")
      .getByRole("button", { name: "Disconnect Browser", exact: true })
      .click();
    await p2.getByRole("dialog").waitFor({ state: "hidden" });
    await p2
      .getByRole("button", { name: "Connect Shared Workspace", exact: true })
      .waitFor();
    assert.equal(
      (await p2.evaluate(() => WWStore.getCases())).length,
      1,
      "Disconnect keeps this device’s cached records.",
    );
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  },
);

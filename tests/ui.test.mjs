/**
 * Browser workflow checks. No browser package is needed by the app itself.
 * Optional setup: npm install --prefix .qa-tools --no-package-lock playwright
 * Run: node --test tests/ui.test.mjs
 * Uses system Chrome (set KARENS_LOAD_BROWSER_EXECUTABLE for another Chromium).
 * Records live in an isolated browser context; no messages can be sent.
 */
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
  "browser case workflow",
  {
    skip: !chromium ? "Optional Playwright library is not installed." : false,
    timeout: 120000,
  },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "karens-load-ui-"));
    const service = createReminderService({
      dataPath: path.join(scratch, "reminders.json"),
      env: {},
      fetchImpl: async () => {
        throw new Error("External messaging is forbidden in UI tests.");
      },
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
      browserExecutable
        ? {
            executablePath: browserExecutable,
            headless: true,
          }
        : { channel: "chrome", headless: true },
    );
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      timezoneId: "America/Los_Angeles",
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(
      `http://127.0.0.1:${server.address().port}`,
    );
    assert.equal(response.status(), 200);
    await page.getByRole("button", { name: "New Case", exact: true }).waitFor();
    const dialog = page.getByRole("dialog");
    await page
      .locator(".demo-banner")
      .getByText("Example Workspace", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: /^All Cases/ })
      .first()
      .click();
    await page
      .getByLabel("Filter Cases", { exact: true })
      .selectOption("active");
    assert.equal(
      await page.locator(".case-card").count(),
      4,
      "First use shows the four active fictional patients.",
    );
    assert.equal(
      await page
        .locator('.stat-card[data-filter="active"] .stat-value')
        .innerText(),
      "4",
    );
    assert.equal(
      await page
        .locator('.stat-card[data-filter="open"] .stat-value')
        .innerText(),
      "2",
    );
    assert.equal(
      await page
        .locator('.stat-card[data-filter="completed"] .stat-value')
        .innerText(),
      "2",
    );
    for (const [filter, count] of [
      ["all", 6],
      ["open", 2],
      ["in_progress", 2],
      ["completed", 2],
      ["active", 4],
    ]) {
      await page
        .getByLabel("Filter Cases", { exact: true })
        .selectOption(filter);
      assert.equal(
        await page.locator(".case-card").count(),
        count,
        `Fictional ${filter} view has ${count} cases.`,
      );
    }
    await page.locator(".case-card").filter({ hasText: "Alex Morgan" }).click();
    await page.getByRole("tab", { name: /^Evidence/ }).click();
    await page
      .getByRole("heading", {
        name: "Sample assessment evidence.txt",
        exact: true,
      })
      .waitFor();
    const sampleDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const sampleText = await readFile(
      await (await sampleDownload).path(),
      "utf8",
    );
    assert.match(sampleText, /FICTIONAL EXAMPLE ONLY/);
    assert.match(sampleText, /Alex Morgan/);
    assert.equal(
      await page
        .getByRole("button", { name: "Copy Path", exact: true })
        .count(),
      1,
    );
    await page
      .getByRole("button", { name: /^All Cases/ })
      .first()
      .click();
    await page
      .getByLabel("Filter Cases", { exact: true })
      .selectOption("completed");
    await page.locator(".case-card").filter({ hasText: "Jordan Lee" }).click();
    await page.getByRole("tab", { name: /^Evidence/ }).click();
    await page
      .getByRole("heading", {
        name: "Sample submission checklist.txt",
        exact: true,
      })
      .waitFor();
    const completedSampleDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const completedSample = await readFile(
      await (await completedSampleDownload).path(),
      "utf8",
    );
    assert.match(completedSample, /FICTIONAL EXAMPLE ONLY/);
    assert.match(completedSample, /Jordan Lee/);
    assert.match(completedSample, /report finalized/);
    await page.getByRole("button", { name: "Overview", exact: true }).click();

    await page.getByRole("button", { name: "New Case", exact: true }).click();
    await dialog
      .getByLabel("Patient Name", { exact: false })
      .fill("UI Test Patient");
    await dialog.getByLabel("Case Opened").fill("2026-11-27");
    await dialog
      .getByLabel("Final Due Date", { exact: false })
      .fill("2026-12-31");
    await dialog
      .getByLabel("Initial Note", { exact: false })
      .fill("First conversation recorded.");
    assert.deepEqual(
      await page.locator(".schedule-preview-weeks strong").allTextContents(),
      ["Dec 3", "Dec 10", "Dec 17", "Dec 24", "Dec 31"],
    );
    await dialog
      .getByRole("button", { name: "Create Case", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "UI Test Patient", exact: true })
      .waitFor();
    assert.equal(await page.locator("[data-task-check]").count(), 19);
    assert.equal(
      await page.getByLabel("Status", { exact: true }).inputValue(),
      "open",
    );
    await page
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("heading", { name: "UI Test Patient", exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".demo-banner").count(),
      0,
      "Removing examples keeps the real case open.",
    );
    assert.equal(
      await page
        .getByRole("button", { name: /^All Cases/ })
        .last()
        .innerText(),
      "All Cases",
    );
    assert.equal(
      (await page.evaluate(() => WWStore.getCases())).length,
      1,
      "Remove examples preserves the newly added real case.",
    );

    // Three changes in one event loop exercise the serialization boundary.
    await page
      .locator("[data-task-check]")
      .evaluateAll((inputs) =>
        inputs.slice(0, 3).forEach((input) => input.click()),
      );
    await page.waitForFunction(
      () =>
        document.querySelectorAll("[data-task-check]:checked").length === 3 &&
        document.querySelector("#case-status")?.value === "in_progress",
    );
    await page.reload();
    await page
      .getByRole("heading", { name: "UI Test Patient", exact: true })
      .waitFor();
    assert.equal(
      await page.locator("[data-task-check]:checked").count(),
      3,
      "Rapid changes survive reload.",
    );
    const secondTab = await context.newPage();
    await secondTab.goto(page.url());
    await secondTab
      .getByRole("heading", { name: /workspace is already open/i })
      .waitFor();
    assert.equal(
      await secondTab
        .getByRole("button", { name: "New Case", exact: true })
        .count(),
      0,
    );
    await secondTab.close();

    await page
      .getByRole("button", {
        name: "Edit Assessment Plan Notification (teacher)",
        exact: true,
      })
      .click();
    await dialog
      .getByLabel("Activity Name")
      .fill("Customized teacher notification");
    await dialog.getByLabel("Activity Due Date").fill("2026-12-05");
    await dialog
      .getByRole("button", { name: "Save Activity", exact: true })
      .click();
    await page
      .getByRole("checkbox", {
        name: "Complete Customized teacher notification",
        exact: true,
      })
      .waitFor();
    await page
      .getByRole("button", { name: "Add Activity", exact: true })
      .first()
      .click();
    await dialog.getByLabel("Activity Name").fill("Additional family meeting");
    await dialog.getByLabel("Plan Week").selectOption("2");
    await dialog.getByLabel("Activity Due Date").fill("2026-12-08");
    await dialog.getByLabel("Only If Needed", { exact: true }).check();
    await dialog
      .getByRole("button", { name: "Add Activity", exact: true })
      .click();
    await page
      .getByRole("checkbox", {
        name: "Complete Additional family meeting",
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator("[data-task-check]").count(), 20);

    await page.getByRole("tab", { name: /^Notes/ }).click();
    assert.equal(
      await page
        .getByText("First conversation recorded.", { exact: true })
        .count(),
      1,
    );
    const note = "Follow-up <strong>literal text</strong>\nSecond line.";
    await page.getByLabel("Add a Case Note").fill(note);
    await page.getByRole("button", { name: "Add Note", exact: true }).click();
    await page.getByText(note, { exact: true }).waitFor();
    assert.equal(
      await page.locator(".note-text strong").count(),
      0,
      "Notes render as text.",
    );

    await page.getByRole("tab", { name: /^Evidence/ }).click();
    const evidence = Buffer.from(
      "Evidence survives backup, clearing, and restoring.\n",
    );
    await page.locator("#evidence-files").setInputFiles({
      name: "test-evidence.txt",
      mimeType: "text/plain",
      buffer: evidence,
    });
    await page
      .getByRole("heading", { name: "test-evidence.txt", exact: true })
      .waitFor();
    let downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    assert.deepEqual(await readFile(await (await downloaded).path()), evidence);
    await page
      .getByRole("button", { name: "Add Document Reference", exact: true })
      .click();
    await dialog.getByLabel("Document Name").fill("Original local report");
    await dialog
      .getByLabel("File Path or Document URL")
      .fill("C:\\Work\\Example Report.pdf");
    await dialog
      .getByRole("button", { name: "Add Reference", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Original local report", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Add Document Reference", exact: true })
      .click();
    await dialog.getByLabel("Document Name").fill("Online report");
    await dialog.getByLabel("Reference Type").selectOption("link");
    await dialog
      .getByLabel("File Path or Document URL")
      .fill("javascript:alert(1)");
    await dialog
      .getByRole("button", { name: "Add Reference", exact: true })
      .click();
    await dialog
      .getByRole("alert")
      .getByText(/http or https/i)
      .waitFor();
    await dialog
      .getByLabel("File Path or Document URL")
      .fill("https://example.com/report");
    await dialog
      .getByRole("button", { name: "Add Reference", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Online report", exact: true })
      .waitFor();
    assert.equal(await page.locator(".attachment-item").count(), 3);

    await page.getByRole("button", { name: "Edit Case", exact: true }).click();
    await dialog
      .getByLabel("Final Due Date", { exact: false })
      .fill("2027-01-07");
    await dialog
      .getByRole("button", { name: "Save Case", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: /^Activities/ }).click();
    const customizedRow = page.locator(".task-row").filter({
      has: page.getByRole("checkbox", {
        name: "Complete Customized teacher notification",
        exact: true,
      }),
    });
    assert.match(
      await customizedRow.innerText(),
      /Dec 12/,
      "Changing deadline preserves custom activity spacing.",
    );
    await page.getByLabel("Status", { exact: true }).selectOption("completed");
    await dialog
      .getByRole("button", { name: "Complete Case", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page.getByLabel("Status", { exact: true }).inputValue(),
      "completed",
    );
    await page
      .getByLabel("Status", { exact: true })
      .selectOption("in_progress");
    await page.waitForFunction(
      () => document.querySelector("#case-status")?.value === "in_progress",
    );

    await page
      .getByRole("button", { name: "Activity Templates", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add Activity", exact: true })
      .click();
    await dialog.getByLabel("Activity Name").fill("Custom template activity");
    await dialog.getByLabel("Plan Week").selectOption("3");
    await dialog
      .getByRole("button", { name: "Add Activity", exact: true })
      .click();
    await page.getByText("Custom template activity", { exact: true }).waitFor();
    assert.equal(await page.locator(".template-row").count(), 20);
    await page.getByRole("button", { name: /^All Cases/ }).click();
    await page.getByRole("button", { name: "New Case", exact: true }).click();
    await dialog
      .getByLabel("Patient Name", { exact: false })
      .fill("Template Patient");
    await dialog
      .getByRole("button", { name: "Create Case", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Template Patient", exact: true })
      .waitFor();
    assert.equal(await page.locator("[data-task-check]").count(), 20);
    await page
      .getByRole("checkbox", {
        name: "Complete Custom template activity",
        exact: true,
      })
      .waitFor();
    await page
      .getByRole("button", { name: "Delete Case", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Delete Case", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: /^All Cases/ })
      .first()
      .click();
    assert.equal(await page.locator(".case-card").count(), 1);

    await page
      .getByRole("button", { name: "Reminders & Settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save Reminders", exact: true })
      .waitFor({ state: "visible" });
    await page.getByLabel("Enable Daily Reminders").check();
    await page
      .getByRole("button", { name: "Save Reminders", exact: true })
      .click();
    await page
      .locator("#reminder-error")
      .getByText(/Select email or SMS/i)
      .waitFor();
    await page.getByLabel("Email Reminders", { exact: false }).check();
    await page.getByLabel("Reminder Email Address").fill("example@example.com");
    await page
      .getByRole("button", { name: "Save Reminders", exact: true })
      .click();
    await page
      .locator("#reminder-error")
      .getByText(/Set up the email provider/i)
      .waitFor();
    await page.getByLabel("Enable Daily Reminders").uncheck();
    await page.getByLabel("Reminder Phone Number").fill("bad");
    await page
      .getByRole("button", { name: "Save Reminders", exact: true })
      .click();
    await page
      .locator("#reminder-error")
      .getByText(/international phone number/i)
      .waitFor();
    await page.getByLabel("Reminder Phone Number").fill("+15551234567");
    await page.getByLabel("Remind Me Before Deadlines").selectOption("7");
    await page.getByLabel("Daily Send Time").fill("10:30");
    await page
      .getByRole("button", { name: "Save Reminders", exact: true })
      .click();
    await page
      .getByRole("status")
      .getByText("Reminder preferences saved.", { exact: true })
      .waitFor();
    const reminderStatus = await service.getStatus();
    assert.equal(reminderStatus.config.enabled, false);
    assert.equal(reminderStatus.config.daysAhead, 7);
    assert.equal(reminderStatus.config.time, "10:30");

    downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download Backup", exact: true })
      .click();
    const backupDownload = await downloaded;
    const backupPath = await backupDownload.path();
    const backup = JSON.parse(await readFile(backupPath, "utf8"));
    assert.equal(backup.format, "weekwise");
    assert.equal(backup.cases.length, 1);
    assert.equal(backup.files.length, 1);
    assert.equal(backup.settings.templates[0].activities.length, 20);
    assert.deepEqual(Buffer.from(backup.files[0].data, "base64"), evidence);
    await page.getByRole("button", { name: /Clear Workspace/ }).click();
    await dialog
      .getByRole("button", { name: "Clear Everything", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: /^All Cases/ })
      .first()
      .click();
    assert.equal(await page.locator(".case-card").count(), 0);
    await page.reload();
    await page.getByRole("button", { name: "New Case", exact: true }).waitFor();
    assert.equal(
      await page.locator(".case-card").count(),
      0,
      "Cleared examples do not return after reload.",
    );
    assert.equal(await page.locator(".demo-banner").count(), 0);
    await page
      .getByRole("button", { name: "Reminders & Settings", exact: true })
      .click();
    await page.locator("#restore-file").setInputFiles(backupPath);
    await dialog
      .getByRole("button", { name: "Restore Backup", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: /^All Cases/ })
      .first()
      .click();
    await page
      .locator(".case-card")
      .filter({ hasText: "UI Test Patient" })
      .click();
    await page.getByRole("tab", { name: /^Evidence/ }).click();
    await page
      .getByRole("heading", { name: "test-evidence.txt", exact: true })
      .waitFor();
    downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    assert.deepEqual(
      await readFile(await (await downloaded).path()),
      evidence,
      "Evidence Blob survives backup restore.",
    );
    await page.getByRole("tab", { name: /^Notes/ }).click();
    await page.getByText(note, { exact: true }).waitFor();
    assert.equal(
      (await service.getStatus()).config.enabled,
      false,
      "Restore keeps reminders disabled.",
    );

    await page.getByRole("button", { name: "Overview", exact: true }).click();
    for (const width of [1365, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `No overflow at ${width}px.`,
      );
    }
    assert.deepEqual(errors, []);
  },
);

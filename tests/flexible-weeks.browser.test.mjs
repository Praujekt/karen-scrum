/** Flexible template weeks and case-only compression preserve the complete plan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
  "templates add and remove weeks while case compression preserves activities, work, and the final deadline",
  {
    skip: !chromium ? "Optional Playwright library is not installed." : false,
    timeout: 120000,
  },
  async (t) => {
    const assets = new Map();
    for (const name of await readdir(new URL("../dist/", import.meta.url))) {
      const type = {
        html: "text/html; charset=utf-8",
        js: "text/javascript; charset=utf-8",
        css: "text/css; charset=utf-8",
        svg: "image/svg+xml",
      }[name.split(".").pop()];
      if (type)
        assets.set("/karen-scrum/" + (name === "index.html" ? "" : name), {
          body: await readFile(new URL("../dist/" + name, import.meta.url)),
          type,
        });
    }
    const server = createServer((request, response) => {
      const asset = assets.get(
        new URL(request.url, "http://localhost").pathname,
      );
      response.writeHead(asset ? 200 : 404, {
        "Content-Type": asset?.type || "text/plain",
        "Cache-Control": "no-store",
      });
      response.end(asset?.body || "Static files only.");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
    });
    const executablePath =
      process.env.KARENS_LOAD_BROWSER_EXECUTABLE ||
      process.env.WEEKWISE_BROWSER_EXECUTABLE;
    browser = await chromium.launch(
      executablePath
        ? { executablePath, headless: true }
        : { channel: "chrome", headless: true },
    );
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      timezoneId: "America/Los_Angeles",
    });
    const page = await context.newPage(),
      errors = [],
      external = [];
    const base = `http://127.0.0.1:${server.address().port}/karen-scrum/`;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== new URL(base).origin) {
        external.push(route.request().url());
        await route.abort();
      } else await route.continue();
    });
    const dialog = page.getByRole("dialog"),
      sidebar = page.locator(".sidebar");
    const library = () =>
      page.evaluate(async () =>
        WWModel.getTemplates(await WWStore.getSettings()),
      );
    const plan = async () =>
      (await library()).find((entry) => entry.name === "Flexible Plan");
    const patient = () =>
      page.evaluate(async () =>
        (await WWStore.getCases()).find(
          (entry) => entry.name === "Flexible Timeline Patient",
        ),
      );
    async function screenshot(name) {
      if (process.env.KARENS_LOAD_SCREENSHOTS !== "1") return;
      await mkdir(new URL("../.qa-artifacts/", import.meta.url), {
        recursive: true,
      });
      await page.screenshot({
        path: fileURLToPath(
          new URL(`../.qa-artifacts/${name}.png`, import.meta.url),
        ),
        fullPage: true,
      });
    }
    async function addActivity({
      title,
      week,
      endWeek,
      mandatory,
      priority,
      optional,
      requiresSubmission,
    }) {
      await page
        .getByRole("button", { name: "Add Activity", exact: true })
        .first()
        .click();
      await dialog.getByLabel("Activity Name", { exact: true }).fill(title);
      if (endWeek && endWeek !== week) {
        await dialog
          .getByLabel("Spans Multiple Weeks", { exact: true })
          .check();
        await dialog
          .getByLabel("Start Week", { exact: true })
          .selectOption(String(week));
        await dialog
          .getByLabel("End Week", { exact: true })
          .selectOption(String(endWeek));
      } else
        await dialog
          .getByLabel("Plan Week", { exact: true })
          .selectOption(String(week));
      if (mandatory)
        await dialog
          .getByRole("checkbox", { name: /^Mandatory(?: Activity)?$/ })
          .check();
      if (priority)
        await dialog
          .getByLabel("Priority", { exact: true })
          .selectOption(priority);
      if (optional)
        await dialog.getByLabel("Only If Needed", { exact: true }).check();
      if (requiresSubmission)
        await dialog
          .getByLabel("Track Written and Submitted Separately", { exact: true })
          .check();
      await dialog
        .getByRole("button", { name: "Add Activity", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
    }

    await page.goto(base);
    await page
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await sidebar
      .getByRole("button", { name: "Activity Templates", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New Template", exact: true })
      .click();
    await dialog
      .getByLabel("Template Name", { exact: true })
      .fill("Flexible Plan");
    await dialog
      .getByRole("button", { name: "Create Template", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    for (let index = 0; index < 2; index++)
      await page.getByRole("button", { name: "Add Week", exact: true }).click();
    await page.waitForFunction(
      async () =>
        WWModel.getTemplates(await WWStore.getSettings()).find(
          (entry) => entry.name === "Flexible Plan",
        ).weekCount === 7,
    );
    await addActivity({
      title: "Essential observation",
      week: 1,
      mandatory: true,
      priority: "high",
    });
    await addActivity({
      title: "Long rating scale",
      week: 2,
      endWeek: 7,
      optional: true,
      priority: "high",
    });
    await addActivity({
      title: "Final report",
      week: 7,
      mandatory: true,
      requiresSubmission: true,
    });
    const original = await plan();
    assert.equal(original.weekCount, 7);
    assert.equal(original.activities.length, 3);
    await page
      .getByRole("button", { name: "Remove Week 2", exact: true })
      .click();
    await dialog.getByRole("button", { name: /^Remove Week(?: 2)?$/ }).click();
    await dialog.waitFor({ state: "hidden" });
    const source = await plan();
    assert.equal(source.weekCount, 6);
    assert.deepEqual(
      source.activities.map((activity) => activity.id).sort(),
      original.activities.map((activity) => activity.id).sort(),
      "Removing a populated week retains every activity.",
    );
    assert.deepEqual(
      source.activities.map((activity) => [
        activity.week,
        activity.endWeek ?? activity.week,
      ]),
      [
        [1, 1],
        [2, 6],
        [6, 6],
      ],
    );
    assert.deepEqual(
      source.activities.map((activity) => [
        !!activity.mandatory,
        activity.priority || "normal",
        !!activity.optional,
      ]),
      [
        [true, "high", false],
        [false, "high", true],
        [true, "normal", false],
      ],
    );
    await screenshot("flexible-template-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Editable template weeks and flags fit a phone.",
    );
    await screenshot("flexible-template-mobile");
    await page.setViewportSize({ width: 1365, height: 900 });
    await sidebar.getByRole("button", { name: /^All Cases\s*\d*$/ }).click();
    await page.getByRole("button", { name: "New Case", exact: true }).click();
    await dialog
      .getByLabel("Patient Name", { exact: false })
      .fill("Flexible Timeline Patient");
    const dates = await page.evaluate(() => ({
      start: WWModel.addDays(WWModel.today(), -10),
      due: WWModel.addDays(WWModel.today(), 55),
    }));
    await dialog.getByLabel("Case Opened", { exact: true }).fill(dates.start);
    await dialog.getByLabel("Final Due Date", { exact: false }).fill(dates.due);
    await dialog
      .getByLabel("Template", { exact: true })
      .selectOption(source.id);
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".schedule-preview-weeks > span").length ===
        6,
    );
    await dialog
      .getByRole("button", { name: "Create Case", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("heading", { name: "Flexible Timeline Patient", exact: true })
      .waitFor();
    assert.equal((await patient()).weekCount, 6);
    assert.equal(await page.locator(".task-week").count(), 6);
    const essentialId = (await patient()).tasks.find(
      (activity) => activity.title === "Essential observation",
    ).id;
    const essentialRow = page.locator(
      `.task-row[data-task-id="${essentialId}"]`,
    );
    await essentialRow.getByText("Mandatory", { exact: true }).waitFor();
    const ratingId = (await patient()).tasks.find(
      (activity) => activity.title === "Long rating scale",
    ).id;
    await page
      .locator(`.task-row[data-task-id="${ratingId}"][data-endpoint="end"]`)
      .getByText("High Priority", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Edit Essential observation", exact: true })
      .click();
    assert.equal(
      await dialog
        .getByLabel("Plan Week", { exact: true })
        .locator('option[value="6"]')
        .count(),
      1,
      "Case activity editors include the copied sixth week.",
    );
    assert.equal(
      await dialog
        .getByLabel("Mandatory Activity", { exact: true })
        .isChecked(),
      true,
    );
    assert.equal(
      await dialog.getByLabel("Priority", { exact: true }).inputValue(),
      "high",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("checkbox", {
        name: "Complete Essential observation",
        exact: true,
      })
      .check();
    await page
      .getByRole("checkbox", { name: "Mark Final report Written", exact: true })
      .check();
    await page.getByRole("tab", { name: /^Notes/ }).click();
    await page
      .getByLabel("Add a Case Note", { exact: true })
      .fill("Preserve this note when shortening the work plan.");
    await page.getByRole("button", { name: "Add Note", exact: true }).click();
    await page
      .getByText("Preserve this note when shortening the work plan.", {
        exact: true,
      })
      .waitFor();
    await page.getByRole("tab", { name: /^Evidence/ }).click();
    const evidence = Buffer.from(
      "Fictional planning evidence, retained byte for byte.\n",
    );
    await page.locator("#evidence-files").setInputFiles({
      name: "planning-evidence.txt",
      mimeType: "text/plain",
      buffer: evidence,
    });
    await page
      .getByRole("heading", { name: "planning-evidence.txt", exact: true })
      .waitFor();
    await page.getByRole("tab", { name: /^Activities/ }).click();
    const before = await patient();
    assert.equal(
      before.tasks[0].dueDate,
      await page.evaluate((date) => WWModel.addDays(date, -35), dates.due),
      "Six-week schedules work backward from the same final deadline.",
    );
    assert.equal(
      before.tasks.find(
        (activity) => activity.title === "Essential observation",
      ).done,
      true,
    );
    assert.equal(
      before.tasks.find((activity) => activity.title === "Final report")
        .written,
      true,
    );
    await page
      .getByRole("button", { name: "Condense Timeline", exact: true })
      .click();
    await dialog
      .getByLabel("Number of Weeks", { exact: true })
      .selectOption("3");
    const preview = dialog.locator("#condense-preview");
    await preview.locator("[data-planning-task-id]").first().waitFor();
    assert.deepEqual(
      (
        await preview
          .locator("[data-planning-task-id]")
          .evaluateAll((rows) => rows.map((row) => row.dataset.planningTaskId))
      ).sort(),
      before.tasks.map((activity) => activity.id).sort(),
    );
    assert.equal(
      await preview
        .locator("[data-planning-task-id] .planning-badge--mandatory")
        .count(),
      2,
    );
    assert.equal(
      await preview
        .locator("[data-planning-task-id] .planning-badge--priority")
        .count(),
      2,
    );
    assert.equal(
      (await patient()).weekCount,
      6,
      "Previewing does not change the case.",
    );
    await screenshot("condense-timeline-preview-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "The compression preview fits a phone.",
    );
    await screenshot("condense-timeline-preview-mobile");
    await dialog
      .getByRole("button", { name: "Condense Timeline", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    const after = await patient();
    assert.equal(after.weekCount, 3);
    assert.equal(
      after.dueDate,
      before.dueDate,
      "The final deadline stays fixed.",
    );
    assert.equal(after.startDate, before.startDate);
    assert.equal(after.status, before.status);
    assert.equal(after.sourceTemplateId, source.id);
    assert.deepEqual(after.notes, before.notes);
    assert.deepEqual(after.attachments, before.attachments);
    const unchanged = ({ week, endWeek, dueDate, ...activity }) => activity;
    assert.deepEqual(
      after.tasks.map(unchanged),
      before.tasks.map(unchanged),
      "IDs, titles, flags, and completed/Written work all survive compression.",
    );
    assert.deepEqual(
      after.tasks.map((activity) => [
        activity.week,
        activity.endWeek ?? activity.week,
      ]),
      [
        [1, 1],
        [1, 3],
        [3, 3],
      ],
    );
    assert.deepEqual(
      after.tasks.map((activity) => activity.dueDate),
      [
        await page.evaluate((date) => WWModel.addDays(date, -14), dates.due),
        dates.due,
        dates.due,
      ],
    );
    assert.deepEqual(
      await plan(),
      source,
      "Condensing a patient plan leaves its reusable template unchanged.",
    );
    assert.equal(await page.locator(".task-week").count(), 3);
    assert.equal(await page.locator("[data-task-check]").count(), 3);
    assert.equal(
      await page
        .locator(".timeline-summary .section-heading > strong")
        .innerText(),
      "33%",
    );
    assert.equal(
      await page.evaluate(
        async (id) => (await WWStore.getFile(id)).text(),
        after.attachments[0].fileId,
      ),
      evidence.toString("utf8"),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "The condensed case and importance flags fit a phone.",
    );
    await screenshot("condensed-case-mobile");
    await page.reload();
    await page
      .getByRole("heading", { name: "Flexible Timeline Patient", exact: true })
      .waitFor();
    assert.equal((await patient()).weekCount, 3);
    assert.deepEqual(await plan(), source);
    await page
      .getByRole("button", { name: "Edit Essential observation", exact: true })
      .click();
    await dialog.getByLabel("Available Weeks", { exact: true }).fill("11");
    await dialog.getByLabel("Available Weeks", { exact: true }).press("Tab");
    await dialog
      .getByLabel("Plan Week", { exact: true })
      .locator('option[value="11"]')
      .waitFor({ state: "attached" });
    await dialog.getByLabel("Plan Week", { exact: true }).selectOption("11");
    const extendedDue = await page.evaluate(
      (date) => WWModel.addDays(date, 56),
      after.dueDate,
    );
    assert.equal(
      await dialog
        .getByLabel("Activity Due Date", { exact: true })
        .inputValue(),
      extendedDue,
    );
    await dialog
      .getByRole("button", { name: "Save Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    const extended = await patient();
    assert.equal(extended.weekCount, 11);
    assert.equal(
      extended.dueDate,
      extendedDue,
      "Appending eight case weeks extends the final deadline by eight weeks.",
    );
    assert.equal(extended.startDate, after.startDate);
    assert.deepEqual(extended.tasks.map(unchanged), after.tasks.map(unchanged));
    const moved = extended.tasks.find(
      (activity) => activity.id === essentialId,
    );
    assert.equal(moved.week, 11);
    assert.equal(moved.endWeek ?? moved.week, 11);
    assert.equal(moved.dueDate, extendedDue);
    assert.deepEqual(
      extended.tasks
        .filter((activity) => activity.id !== essentialId)
        .map((activity) => [activity.id, activity.dueDate]),
      after.tasks
        .filter((activity) => activity.id !== essentialId)
        .map((activity) => [activity.id, activity.dueDate]),
      "Moving one activity into an added week leaves all other activity dates unchanged.",
    );
    assert.deepEqual(extended.notes, after.notes);
    assert.deepEqual(extended.attachments, after.attachments);
    assert.deepEqual(
      await plan(),
      source,
      "Adding weeks in a patient's activity editor does not change the saved six-week template.",
    );
    assert.equal(await page.locator(".task-week").count(), 11);
    for (const week of [6, 7, 8, 9, 10]) {
      const section = page.locator(".task-week").filter({
        has: page.getByRole("heading", { name: "Week " + week, exact: true }),
      });
      assert.equal(await section.count(), 1);
      assert.equal(
        await section.locator(".task-row").count(),
        0,
        `Unused Week ${week} stays available in the expanded plan.`,
      );
    }
    assert.equal(await page.locator("[data-task-check]").count(), 3);
    assert.equal(
      await page.evaluate(
        async (id) => (await WWStore.getFile(id)).text(),
        extended.attachments[0].fileId,
      ),
      evidence.toString("utf8"),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "The eleven-week case fits a phone.",
    );
    await screenshot("expanded-case-mobile");
    await page.setViewportSize({ width: 1365, height: 900 });
    await screenshot("expanded-case-desktop");
    await page.reload();
    await page
      .getByRole("heading", { name: "Flexible Timeline Patient", exact: true })
      .waitFor();
    assert.equal((await patient()).weekCount, 11);
    assert.deepEqual(await plan(), source);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  },
);

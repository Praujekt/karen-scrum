/** Case planning, separate writing/submission stages, and the actionable Overview. */
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

const options = {
  skip: !chromium ? "Optional Playwright library is not installed." : false,
  timeout: 120000,
};

async function workspace(t) {
  const assets = new Map();
  for (const name of await readdir(new URL("../dist/", import.meta.url))) {
    const type = {
      html: "text/html; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      css: "text/css; charset=utf-8",
      svg: "image/svg+xml",
    }[name.split(".").pop()];
    if (!type) continue;
    assets.set("/karen-scrum/" + (name === "index.html" ? "" : name), {
      body: await readFile(new URL("../dist/" + name, import.meta.url)),
      type,
    });
  }
  const server = createServer((request, response) => {
    const asset = assets.get(new URL(request.url, "http://localhost").pathname);
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
  const page = await context.newPage();
  const base = `http://127.0.0.1:${server.address().port}/karen-scrum/`;
  const errors = [],
    external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== new URL(base).origin) {
      external.push(route.request().url());
      await route.abort();
    } else await route.continue();
  });
  await page.goto(base);
  await page.getByRole("button", { name: "New Case", exact: true }).waitFor();
  const dialog = page.getByRole("dialog");
  await page
    .getByRole("button", { name: "Remove Examples", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Remove Examples", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  return {
    page,
    base,
    dialog,
    sidebar: page.locator(".sidebar"),
    errors,
    external,
  };
}

function records(page) {
  return page.evaluate(() => WWStore.getCases());
}
async function record(page, name) {
  return (await records(page)).find((entry) => entry.name === name);
}
function templates(page) {
  return page.evaluate(async () =>
    WWModel.getTemplates(await WWStore.getSettings()),
  );
}
async function template(page, name) {
  return (await templates(page)).find((entry) => entry.name === name);
}
async function waitTask(page, name, title, expected) {
  await page.waitForFunction(
    async ({ name, title, expected }) => {
      const entry = (await WWStore.getCases()).find(
        (item) => item.name === name,
      );
      const task = entry?.tasks.find((item) => item.title === title);
      return (
        task &&
        Object.entries(expected).every(([key, value]) => task[key] === value)
      );
    },
    { name, title, expected },
  );
}
async function openCase(page, name) {
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^All Cases\s*\d*$/ })
    .click();
  await page.locator(".case-card").filter({ hasText: name }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
}
async function overview(page) {
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "At a Glance", exact: true })
    .waitFor();
}
async function library(page) {
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Activity Templates", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Activity Templates", exact: true })
    .waitFor();
}
async function createCase(page, name, templateName, dueDate) {
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "New Case", exact: true }).click();
  await dialog.getByLabel("Patient Name", { exact: false }).fill(name);
  await dialog
    .getByLabel("Case Opened", { exact: true })
    .fill(await page.evaluate(() => WWModel.addDays(WWModel.today(), -30)));
  await dialog.getByLabel("Final Due Date", { exact: false }).fill(dueDate);
  await dialog
    .getByLabel("Template", { exact: true })
    .selectOption((await template(page, templateName)).id);
  await dialog
    .getByRole("button", { name: "Create Case", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name, exact: true }).waitFor();
}
async function screenshot(page, name) {
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
async function assertFits(page, message) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    message,
  );
}
function endpoint(page, kind, id, stage) {
  return page.locator(
    `.${kind}-row[data-task-id="${id}"][data-endpoint="${stage}"]`,
  );
}
async function assertEndpoints(page, kind, task) {
  const start = endpoint(page, kind, task.id, "start");
  const end = endpoint(page, kind, task.id, "end");
  assert.equal(
    await page.locator(`.${kind}-row[data-task-id="${task.id}"]`).count(),
    2,
  );
  for (const [row, week, label] of [
    [start, task.week, "Starting Week"],
    [end, task.endWeek, "Ending Week"],
  ]) {
    assert.equal(
      await row.locator(".activity-endpoint-label").innerText(),
      label,
    );
    const text = await row.innerText();
    assert.ok(text.includes(task.title));
    assert.ok(
      text.indexOf(label) < text.indexOf(task.title),
      "The week label precedes the activity title.",
    );
    assert.equal(
      await row.evaluate((element) =>
        element.closest("section").querySelector("h2").textContent.trim(),
      ),
      "Week " + week,
    );
  }
  assert.equal(
    await start.locator("[data-task-check], [data-task-written]").count(),
    0,
    "The Start marker does not create a second completion step.",
  );
  if (kind === "task") {
    assert.equal(await end.locator("[data-task-check]").count(), 1);
    assert.equal(
      await end.locator("[data-task-written]").count(),
      task.requiresSubmission ? 1 : 0,
    );
    assert.equal(
      await start.locator(".task-start-marker, .task-endpoint-help").count(),
      0,
      "The starting entry follows the ordinary row layout without a special arrow or helper.",
    );
    for (const row of [start, end])
      assert.equal(await row.locator(".task-title").innerText(), task.title);
  }
  return { start, end };
}
async function assertEndpointCompletion(page, task, done) {
  for (const stage of ["start", "end"]) {
    assert.equal(
      await endpoint(page, "task", task.id, stage).evaluate((element) =>
        element.classList.contains("is-done"),
      ),
      done,
      `The ${stage} marker reflects the one underlying completion state.`,
    );
  }
}
function calendarLabel(iso) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(iso + "T12:00:00Z"));
}
async function assertLeftControls(ordinary, staged) {
  const ordinaryBox = await ordinary.locator("[data-task-check]").boundingBox();
  const titleBox = await staged.locator(".task-title").boundingBox();
  const columnBox = await staged.locator(".task-stage-checks").boundingBox();
  assert.ok(ordinaryBox && titleBox && columnBox);
  assert.ok(
    columnBox.x + columnBox.width <= titleBox.x + 1,
    "Written/Submitted controls sit entirely to the left of the title.",
  );
  assert.ok(
    columnBox.y < titleBox.y + titleBox.height &&
      titleBox.y < columnBox.y + columnBox.height,
    "The controls stay beside the title rather than below it.",
  );
  for (const control of await staged
    .locator("[data-task-check], [data-task-written]")
    .all()) {
    const box = await control.boundingBox();
    assert.ok(
      Math.abs(box.x - ordinaryBox.x) <= 1,
      "Both staged checkboxes align with the ordinary checkbox.",
    );
  }
}

test(
  "starting and ending week markers and Written/Submitted stages remain one activity across templates and cases",
  options,
  async (t) => {
    const { page, dialog, errors, external } = await workspace(t);
    await library(page);
    await page
      .getByRole("button", { name: "New Template", exact: true })
      .click();
    await dialog
      .getByLabel("Template Name", { exact: true })
      .fill("Extended Reports");
    await dialog
      .getByRole("button", { name: "Create Template", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "Add Activity", exact: true })
      .first()
      .click();
    await dialog
      .getByLabel("Activity Name", { exact: true })
      .fill("Long report");
    assert.equal(
      await dialog.getByLabel("Plan Week", { exact: true }).inputValue(),
      "1",
    );
    assert.equal(
      await dialog.getByLabel("End Week", { exact: true }).isVisible(),
      false,
    );
    await dialog.getByLabel("Spans Multiple Weeks", { exact: true }).check();
    await dialog.getByLabel("Start Week", { exact: true }).selectOption("1");
    await dialog.getByLabel("End Week", { exact: true }).selectOption("5");
    await dialog
      .getByLabel("Track Written and Submitted Separately", { exact: true })
      .check();
    await dialog
      .getByRole("button", { name: "Add Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "Add Activity", exact: true })
      .first()
      .click();
    await dialog
      .getByLabel("Activity Name", { exact: true })
      .fill("Release form");
    await dialog.getByLabel("Plan Week", { exact: true }).selectOption("2");
    await dialog.getByLabel("Only If Needed", { exact: true }).check();
    await dialog
      .getByRole("button", { name: "Add Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    const original = await template(page, "Extended Reports");
    await assertEndpoints(page, "template", original.activities[0]);
    assert.equal(await page.locator(".template-row").count(), 3);
    assert.equal(
      await endpoint(
        page,
        "template",
        original.activities[1].id,
        "single",
      ).count(),
      1,
    );
    await screenshot(page, "activity-endpoints-template-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await assertFits(page, "Template Start/End entries fit a phone viewport.");
    await screenshot(page, "activity-endpoints-template-mobile");
    await page.setViewportSize({ width: 1365, height: 900 });
    assert.deepEqual(
      original.activities.map((activity) => [
        activity.title,
        activity.week,
        activity.endWeek ?? activity.week,
        !!activity.requiresSubmission,
      ]),
      [
        ["Long report", 1, 5, true],
        ["Release form", 2, 2, false],
      ],
    );
    await page
      .getByRole("button", { name: "Copy Template", exact: true })
      .click();
    await dialog
      .getByLabel("Template Name", { exact: true })
      .fill("Extended Reports Copy");
    await dialog
      .getByRole("button", { name: "Create Copy", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    const copied = await template(page, "Extended Reports Copy");
    assert.notEqual(copied.activities[0].id, original.activities[0].id);
    assert.equal(copied.activities[0].endWeek, 5);
    assert.equal(copied.activities[0].requiresSubmission, true);
    await assertEndpoints(page, "template", copied.activities[0]);
    const dueDate = await page.evaluate(() =>
      WWModel.addDays(WWModel.today(), 40),
    );
    await page
      .locator(".sidebar")
      .getByRole("button", { name: /^All Cases\s*\d*$/ })
      .click();
    await createCase(page, "Range Patient A", "Extended Reports", dueDate);
    let first = await record(page, "Range Patient A");
    assert.equal(
      first.tasks[0].dueDate,
      dueDate,
      "A Weeks 1–5 activity ends on the final deadline.",
    );
    assert.equal(first.tasks[0].written, false);
    assert.equal(first.tasks[0].done, false);
    const firstEndpoints = await assertEndpoints(page, "task", first.tasks[0]);
    const startDate = await page.evaluate(
      (entry) => WWModel.activityStartDate(entry, entry.tasks[0]),
      first,
    );
    assert.ok(
      (await firstEndpoints.start.innerText()).includes(
        calendarLabel(startDate),
      ),
    );
    assert.ok(
      (await firstEndpoints.end.innerText()).includes(calendarLabel(dueDate)),
    );
    assert.equal(
      await page.locator(".task-row").count(),
      3,
      "Two activities create two End controls and one Start marker.",
    );
    assert.equal(await page.locator("[data-task-check]").count(), 2);
    assert.equal(await page.locator("[data-task-written]").count(), 1);
    await assertLeftControls(
      endpoint(page, "task", first.tasks[1].id, "single"),
      firstEndpoints.end,
    );
    assert.equal(
      await endpoint(page, "task", first.tasks[1].id, "single").count(),
      1,
    );
    assert.equal(
      await endpoint(page, "task", first.tasks[1].id, "single")
        .locator(".optional-tag")
        .innerText(),
      "If Needed",
    );
    assert.match(
      await firstEndpoints.start.locator("xpath=..").innerText(),
      /1 Starting/,
    );
    assert.equal(
      await firstEndpoints.start
        .locator("xpath=..")
        .locator(".week-done")
        .innerText(),
      "No Activities Due",
      "The starting marker does not create a second due activity in Week 1.",
    );
    assert.equal(
      await firstEndpoints.end
        .locator("xpath=..")
        .locator(".week-done")
        .innerText(),
      "0/1 Complete",
    );
    assert.equal(
      first.tasks[1].dueDate,
      await page.evaluate((date) => WWModel.addDays(date, -21), dueDate),
    );
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Complete Release form", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "Mark Release form Written",
          exact: true,
        })
        .count(),
      0,
    );
    await page
      .getByRole("checkbox", { name: "Mark Long report Written", exact: true })
      .check();
    await waitTask(page, "Range Patient A", "Long report", {
      written: true,
      done: false,
    });
    first = await record(page, "Range Patient A");
    assert.equal(first.status, "in_progress");
    assert.equal(
      first.tasks.filter((task) => task.done).length,
      0,
      "Writing alone does not complete an activity.",
    );
    assert.equal(
      await page
        .locator(".timeline-summary .section-heading > strong")
        .innerText(),
      "0%",
    );
    await overview(page);
    const submit = page.locator(
      '[data-action="overview-submit"][data-id="' + first.tasks[0].id + '"]',
    );
    await submit.waitFor();
    assert.equal(
      await page
        .locator(".overview-activity")
        .filter({ hasText: "Long report" })
        .count(),
      0,
      "The distant report is queued for submission even outside the deadline list.",
    );
    assert.equal(
      await page.getByLabel("View Through", { exact: true }).inputValue(),
      await page.evaluate(() => WWModel.addDays(WWModel.today(), 7)),
    );
    await page.getByLabel("View Through", { exact: true }).fill(dueDate);
    await page.getByLabel("View Through", { exact: true }).press("Tab");
    await page
      .locator(".overview-activity")
      .filter({ hasText: "Long report" })
      .waitFor();
    assert.deepEqual(
      (await page.locator(".overview-activity-title").allTextContents()).sort(),
      ["Long report", "Long report", "Release form"].sort(),
      "The deadline list and one submission callout use the underlying title, not extra Start/End tasks.",
    );
    assert.equal(
      await page.locator(".overview-activity").count(),
      2,
      "If Needed remains included and Start markers do not add deadlines.",
    );
    assert.equal(await page.locator(".overview-ready-item").count(), 1);
    await submit.click();
    await waitTask(page, "Range Patient A", "Long report", {
      written: true,
      done: true,
    });
    assert.equal(await submit.count(), 0);
    first = await record(page, "Range Patient A");
    assert.equal(first.tasks.filter((task) => task.done).length, 1);
    assert.equal(
      first.status,
      "in_progress",
      "Submitting an activity leaves case completion under her control.",
    );
    await openCase(page, "Range Patient A");
    await assertEndpointCompletion(page, first.tasks[0], true);
    assert.equal(
      await page
        .locator(".timeline-summary .section-heading > strong")
        .innerText(),
      "50%",
    );
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "Mark Long report Written",
          exact: true,
        })
        .isChecked(),
      true,
    );
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "Mark Long report Submitted",
          exact: true,
        })
        .isChecked(),
      true,
    );
    await page
      .getByRole("checkbox", {
        name: "Mark Long report Submitted",
        exact: true,
      })
      .uncheck();
    await waitTask(page, "Range Patient A", "Long report", {
      written: true,
      done: false,
    });
    await assertEndpointCompletion(page, first.tasks[0], false);
    await page
      .getByRole("checkbox", { name: "Mark Long report Written", exact: true })
      .uncheck();
    await waitTask(page, "Range Patient A", "Long report", {
      written: false,
      done: false,
    });
    await page
      .getByRole("checkbox", {
        name: "Mark Long report Submitted",
        exact: true,
      })
      .check();
    await waitTask(page, "Range Patient A", "Long report", {
      written: true,
      done: true,
    });
    await assertEndpointCompletion(page, first.tasks[0], true);
    await page
      .getByRole("checkbox", { name: "Mark Long report Written", exact: true })
      .uncheck();
    await waitTask(page, "Range Patient A", "Long report", {
      written: false,
      done: false,
    });
    await assertEndpointCompletion(page, first.tasks[0], false);
    await endpoint(page, "task", first.tasks[0].id, "start")
      .getByRole("button", { name: "Edit Long report", exact: true })
      .click();
    assert.equal(
      await dialog
        .getByLabel("Spans Multiple Weeks", { exact: true })
        .isChecked(),
      true,
    );
    assert.equal(
      await dialog.getByLabel("Start Week", { exact: true }).inputValue(),
      "1",
    );
    assert.equal(
      await dialog.getByLabel("End Week", { exact: true }).inputValue(),
      "5",
    );
    await dialog
      .getByLabel("Activity Name", { exact: true })
      .fill("Case report only");
    await dialog.getByLabel("Start Week", { exact: true }).selectOption("2");
    await dialog.getByLabel("End Week", { exact: true }).selectOption("4");
    await dialog
      .getByRole("button", { name: "Save Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    first = await record(page, "Range Patient A");
    assert.equal(first.tasks[0].week, 2);
    assert.equal(first.tasks[0].endWeek, 4);
    assert.equal(
      first.tasks[0].dueDate,
      await page.evaluate((date) => WWModel.addDays(date, -7), dueDate),
    );
    await assertEndpoints(page, "task", first.tasks[0]);
    assert.equal(
      await page
        .getByRole("button", { name: "Edit Long report", exact: true })
        .count(),
      0,
      "Both endpoint titles update after editing the underlying activity.",
    );
    assert.equal(
      (await template(page, "Extended Reports")).activities[0].title,
      "Long report",
    );
    await page
      .getByRole("button", { name: "Edit Release form", exact: true })
      .click();
    await dialog.getByLabel("Spans Multiple Weeks", { exact: true }).check();
    await dialog.getByLabel("Start Week", { exact: true }).selectOption("1");
    await dialog.getByLabel("End Week", { exact: true }).selectOption("5");
    assert.equal(
      await dialog
        .getByLabel("Activity Due Date", { exact: true })
        .inputValue(),
      dueDate,
    );
    await dialog
      .getByRole("button", { name: "Save Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    first = await record(page, "Range Patient A");
    assert.equal(first.tasks[1].week, 1);
    assert.equal(first.tasks[1].endWeek, 5);
    assert.equal(first.tasks[1].dueDate, dueDate);
    await assertEndpoints(page, "task", first.tasks[1]);
    assert.equal(await page.locator(".task-row").count(), 4);
    assert.equal(await page.locator("[data-task-check]").count(), 2);
    await page
      .getByRole("checkbox", { name: "Complete Release form", exact: true })
      .check();
    await waitTask(page, "Range Patient A", "Release form", { done: true });
    await assertEndpointCompletion(page, first.tasks[1], true);
    assert.equal(
      await page
        .locator(".timeline-summary .section-heading > strong")
        .innerText(),
      "50%",
    );
    await page
      .getByRole("checkbox", { name: "Complete Release form", exact: true })
      .uncheck();
    await waitTask(page, "Range Patient A", "Release form", { done: false });
    await assertEndpointCompletion(page, first.tasks[1], false);
    assert.equal(
      (await template(page, "Extended Reports")).activities[1].endWeek ?? 2,
      2,
    );
    await page
      .getByRole("checkbox", {
        name: "Mark Case report only Written",
        exact: true,
      })
      .check();
    await waitTask(page, "Range Patient A", "Case report only", {
      written: true,
      done: false,
    });
    await library(page);
    await page
      .getByRole("button", {
        name: "Select Template: Extended Reports",
        exact: true,
      })
      .click();
    await endpoint(page, "template", original.activities[0].id, "end")
      .getByRole("button", { name: /^Edit Template Long report$/i })
      .click();
    await dialog
      .getByLabel("Activity Name", { exact: true })
      .fill("Revised template report");
    await dialog.getByLabel("Start Week", { exact: true }).selectOption("2");
    await dialog.getByLabel("End Week", { exact: true }).selectOption("4");
    await dialog
      .getByRole("button", { name: "Save Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await assertEndpoints(
      page,
      "template",
      (await template(page, "Extended Reports")).activities[0],
    );
    await page
      .locator(".sidebar")
      .getByRole("button", { name: /^All Cases\s*\d*$/ })
      .click();
    await createCase(page, "Range Patient B", "Extended Reports", dueDate);
    const second = await record(page, "Range Patient B");
    assert.equal(second.tasks[0].title, "Revised template report");
    assert.equal(second.tasks[0].week, 2);
    assert.equal(second.tasks[0].endWeek, 4);
    assert.equal(
      second.tasks[0].dueDate,
      await page.evaluate((date) => WWModel.addDays(date, -7), dueDate),
    );
    await assertEndpoints(page, "task", second.tasks[0]);
    assert.equal(second.tasks[0].written, false);
    assert.equal(second.tasks[0].done, false);
    assert.notEqual(first.tasks[0].id, second.tasks[0].id);
    assert.equal(
      (await record(page, "Range Patient A")).tasks[0].title,
      "Case report only",
    );
    assert.equal(
      (await record(page, "Range Patient A")).tasks[0].written,
      true,
    );
    assert.equal(
      (await template(page, "Extended Reports Copy")).activities[0].title,
      "Long report",
    );
    await library(page);
    await page
      .getByRole("button", {
        name: "Select Template: Extended Reports Copy",
        exact: true,
      })
      .click();
    await assertEndpoints(page, "template", copied.activities[0]);
    await endpoint(page, "template", copied.activities[0].id, "end")
      .getByRole("button", { name: /^Edit Template Long report$/i })
      .click();
    await dialog
      .getByRole("button", { name: "Remove Activity", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Remove Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      (await template(page, "Extended Reports Copy")).activities.length,
      1,
    );
    assert.equal(
      await page
        .locator(`.template-row[data-task-id="${copied.activities[0].id}"]`)
        .count(),
      0,
      "Removing from either endpoint removes the one template activity and both markers.",
    );
    assert.equal(
      (await template(page, "Extended Reports")).activities.length,
      2,
    );
    assert.equal((await record(page, "Range Patient B")).tasks.length, 2);
    await openCase(page, "Range Patient A");
    await page.reload();
    await page
      .getByRole("heading", { name: "Range Patient A", exact: true })
      .waitFor();
    assert.equal((await record(page, "Range Patient A")).tasks[1].endWeek, 5);
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "Mark Case report only Written",
          exact: true,
        })
        .isChecked(),
      true,
    );
    await screenshot(page, "activity-stages-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await assertFits(
      page,
      "Week ranges and both activity stages fit a phone viewport.",
    );
    await assertLeftControls(
      endpoint(page, "task", first.tasks[1].id, "end"),
      endpoint(page, "task", first.tasks[0].id, "end"),
    );
    await screenshot(page, "activity-stages-mobile");
    await endpoint(page, "task", first.tasks[0].id, "end")
      .getByRole("button", { name: "Edit Case report only", exact: true })
      .click();
    await assertFits(page, "The activity editor fits a phone viewport.");
    await dialog
      .getByRole("button", { name: "Remove Activity", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Remove Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      (await record(page, "Range Patient A")).tasks.map((task) => task.title),
      ["Release form"],
    );
    assert.equal(
      await page
        .locator(`.task-row[data-task-id="${first.tasks[0].id}"]`)
        .count(),
      0,
      "Removing a case activity through its End editor removes both entries.",
    );
    assert.equal(await page.locator("[data-task-check]").count(), 1);
    assert.equal((await record(page, "Range Patient B")).tasks.length, 2);
    assert.equal(
      (await template(page, "Extended Reports")).activities.length,
      2,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  },
);

test(
  "starting-week urgency follows the week window, final deadline, and activity state",
  options,
  async (t) => {
    const { page, base, errors, external } = await workspace(t);
    const fixtures = await page.evaluate(async () => {
      const M = WWModel,
        today = M.today(),
        result = {};
      for (const [key, offset, options = {}] of [
        ["passed", 27],
        ["today", 28],
        ["soon", 35],
        ["later", 36],
        ["custom", 35, { dueOffset: 2 }],
        ["written", 27, { written: true }],
        ["finalPassed", -1, { written: true }],
        ["taskCompleted", -1, { written: true, done: true }],
        ["caseCompleted", -1, { status: "completed" }],
      ]) {
        const entry = M.createCase({
          name: "Urgency " + key,
          startDate: M.addDays(today, -40),
          dueDate: M.addDays(today, offset),
          template: [
            {
              id: M.uid(),
              title: "Spanning activity",
              week: 1,
              endWeek: 5,
              requiresSubmission: true,
            },
          ],
        });
        entry.status = options.status || "in_progress";
        entry.tasks[0].written = !!options.written;
        entry.tasks[0].done = !!options.done;
        if (options.dueOffset !== undefined)
          entry.tasks[0].dueDate = M.addDays(today, options.dueOffset);
        await WWStore.saveCase(entry);
        result[key] = entry;
      }
      return result;
    });
    await page.reload();
    await page
      .getByRole("heading", { name: "At a Glance", exact: true })
      .waitFor();
    async function focus(key) {
      const entry = fixtures[key];
      await page.goto(base + "#case/" + entry.id);
      await page
        .getByRole("heading", { name: entry.name, exact: true })
        .waitFor();
      return entry.tasks[0];
    }
    async function warning(task, stage, kind, text) {
      const row = endpoint(page, "task", task.id, stage);
      const active = await row.evaluate((element) =>
        ["urgent-overdue", "urgent-soon"].filter((name) =>
          element.classList.contains(name),
        ),
      );
      assert.deepEqual(
        active,
        kind ? [kind] : [],
        `${stage} has the expected urgency.`,
      );
      if (text)
        assert.match(
          await row.locator(".activity-due-label").innerText(),
          text,
        );
      else assert.equal(await row.locator(".activity-due-label").count(), 0);
    }
    for (const [key, kind, text] of [
      ["passed", "urgent-overdue", /^Start Week Passed$/],
      ["today", "urgent-soon", /^Start Week Ends Today$/],
      ["soon", "urgent-soon", /^Start Week Ends in 7 Days$/],
      ["later", null, null],
      ["custom", "urgent-soon", /^Start Week Ends in 2 Days$/],
    ]) {
      const task = await focus(key);
      await warning(task, "start", kind, text);
      await warning(
        task,
        "end",
        key === "custom" ? "urgent-soon" : null,
        key === "custom" ? /due in 2 days/i : null,
      );
      assert.equal(
        await endpoint(page, "task", task.id, "start")
          .locator("input[type=checkbox]")
          .count(),
        0,
      );
      if (key === "passed") {
        await screenshot(page, "activity-start-urgency-desktop");
        await page.setViewportSize({ width: 390, height: 844 });
        await assertFits(
          page,
          "A passed starting week and future ending date fit a phone.",
        );
        await screenshot(page, "activity-start-urgency-mobile");
        await page.setViewportSize({ width: 1365, height: 900 });
      }
    }
    let task = await focus("written");
    await warning(task, "start", null, null);
    await warning(task, "end", null, null);
    await page.locator(`[data-task-written="${task.id}"]`).uncheck();
    await waitTask(page, fixtures.written.name, task.title, {
      written: false,
      done: false,
    });
    await warning(task, "start", "urgent-overdue", /^Start Week Passed$/);
    await page.locator(`[data-task-written="${task.id}"]`).check();
    await waitTask(page, fixtures.written.name, task.title, {
      written: true,
      done: false,
    });
    await warning(task, "start", null, null);
    task = await focus("finalPassed");
    for (const stage of ["start", "end"])
      await warning(task, stage, "urgent-overdue", /1(?:d| day) overdue/i);
    await page.locator(`[data-task-check="${task.id}"]`).check();
    await waitTask(page, fixtures.finalPassed.name, task.title, {
      written: true,
      done: true,
    });
    await assertEndpointCompletion(page, task, true);
    for (const stage of ["start", "end"])
      await warning(task, stage, null, null);
    await page.locator(`[data-task-check="${task.id}"]`).uncheck();
    await waitTask(page, fixtures.finalPassed.name, task.title, {
      written: true,
      done: false,
    });
    for (const stage of ["start", "end"])
      await warning(task, stage, "urgent-overdue", /1(?:d| day) overdue/i);
    for (const key of ["taskCompleted", "caseCompleted"]) {
      task = await focus(key);
      for (const stage of ["start", "end"])
        await warning(task, stage, null, null);
    }
    assert.ok(
      (await records(page)).every((entry) => entry.tasks.length === 1),
      "Week markers and urgency never create additional activities.",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  },
);

test(
  "Overview keeps overdue work prominent, includes the selected date, and exposes all unsubmitted writing",
  options,
  async (t) => {
    const { page, errors, external } = await workspace(t);
    const dates = await page.evaluate(async () => {
      const M = WWModel,
        today = M.today();
      const activities = [
        ["Overdue observation", -1],
        ["Interview due today", 0],
        ["Boundary review", 7],
        ["Beyond this week", 8],
        ["Already completed", -2],
        ["Future report ready", 30],
      ];
      const due = M.createCase({
        name: "Deadline Patient",
        startDate: M.addDays(today, -35),
        dueDate: M.addDays(today, 7),
        template: activities.map(([title], index) => ({
          id: "fixture-" + index,
          title,
          week: 5,
          ...(title === "Future report ready"
            ? { requiresSubmission: true }
            : {}),
        })),
      });
      due.status = "in_progress";
      due.tasks.forEach((task, index) => {
        task.dueDate = M.addDays(today, activities[index][1]);
        task.done = task.title === "Already completed";
        task.written = task.title === "Future report ready";
      });
      const completed = M.createCase({
        name: "Completed Patient",
        startDate: M.addDays(today, -35),
        dueDate: M.addDays(today, -2),
        template: [
          {
            id: "completed-stage",
            title: "Closed case writing",
            week: 5,
            requiresSubmission: true,
          },
        ],
      });
      completed.status = "completed";
      completed.tasks[0].written = true;
      const later = M.createCase({
        name: "Later Patient",
        startDate: today,
        dueDate: M.addDays(today, 20),
        template: [{ id: "later-task", title: "Later case activity", week: 5 }],
      });
      await WWStore.saveCase(due);
      await WWStore.saveCase(completed);
      await WWStore.saveCase(later);
      return {
        today,
        week: M.addDays(today, 7),
        eight: M.addDays(today, 8),
        fortnight: M.addDays(today, 14),
        month: M.addDays(today, 30),
        taskId: due.tasks[5].id,
        caseId: due.id,
      };
    });
    await page.reload();
    await page
      .getByRole("heading", { name: "At a Glance", exact: true })
      .waitFor();
    const cutoff = page.getByLabel("View Through", { exact: true });
    const activities = page.locator(".overview-activity");
    const ready = page.locator(".overview-ready-item");
    const caseDeadlines = page.locator(".overview-case-deadline");
    const titles = () =>
      activities.locator(".overview-activity-title").allTextContents();
    assert.equal(await cutoff.inputValue(), dates.week);
    assert.deepEqual(await titles(), [
      "Overdue observation",
      "Interview due today",
      "Boundary review",
    ]);
    assert.equal(
      await page
        .locator('.overview-range[data-days="7"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.deepEqual(
      await ready.locator(".overview-activity-title").allTextContents(),
      ["Future report ready"],
    );
    assert.equal(await caseDeadlines.count(), 1);
    assert.equal(
      await caseDeadlines.locator(".overview-patient").innerText(),
      "Deadline Patient",
    );
    assert.equal(
      await page
        .locator(".overview-stat--overdue .overview-stat-value")
        .innerText(),
      "1",
    );
    assert.equal(
      await page
        .locator(".overview-stat--today .overview-stat-value")
        .innerText(),
      "1",
    );
    assert.equal(
      await page
        .locator(".overview-stat--total .overview-stat-value")
        .innerText(),
      "3",
    );
    const overdue = page.locator(".overview-date-group--overdue");
    const soon = page.locator(".overview-date-group--soon");
    assert.match(
      await overdue.locator(".overview-urgency").innerText(),
      /1 Day Overdue/,
    );
    assert.match(
      await soon.locator(".overview-urgency").innerText(),
      /Due in 7 Days/,
    );
    const styles = await page.evaluate(() => {
      const read = (selector) => {
        const element = document.querySelector(selector),
          style = getComputedStyle(element);
        return {
          width: parseFloat(style.borderLeftWidth),
          color: style.borderLeftColor,
          background: getComputedStyle(
            element.querySelector(".overview-date-heading"),
          ).backgroundColor,
          animation: getComputedStyle(element.querySelector(".overview-signal"))
            .animationName,
        };
      };
      return {
        overdue: read(".overview-date-group--overdue"),
        soon: read(".overview-date-group--soon"),
      };
    });
    assert.ok(
      styles.overdue.width >= 3,
      "Overdue work has a visible colored edge.",
    );
    assert.ok(
      styles.soon.width >= 3,
      "Near-due work has a visible colored edge.",
    );
    assert.notEqual(
      styles.overdue.color,
      styles.soon.color,
      "Overdue and approaching deadlines have distinct urgency colors.",
    );
    assert.notEqual(styles.overdue.background, styles.soon.background);
    assert.equal(
      styles.overdue.animation,
      "none",
      "Urgency remains steady and unobtrusive.",
    );
    assert.equal(styles.soon.animation, "none");
    await screenshot(page, "overview-deadlines-desktop");
    await cutoff.fill(dates.eight);
    await cutoff.press("Tab");
    await activities.filter({ hasText: "Beyond this week" }).waitFor();
    assert.deepEqual(await titles(), [
      "Overdue observation",
      "Interview due today",
      "Boundary review",
      "Beyond this week",
    ]);
    await page.getByLabel("View Through", { exact: true }).fill(dates.today);
    await page.getByLabel("View Through", { exact: true }).press("Tab");
    await page.waitForFunction(
      () => document.querySelectorAll(".overview-activity").length === 2,
    );
    assert.deepEqual(await titles(), [
      "Overdue observation",
      "Interview due today",
    ]);
    assert.equal(
      await ready.count(),
      1,
      "Written work stays actionable outside the deadline window.",
    );
    assert.equal(await caseDeadlines.count(), 0);
    await page.locator('.overview-range[data-days="14"]').click();
    assert.equal(
      await page.getByLabel("View Through", { exact: true }).inputValue(),
      dates.fortnight,
    );
    assert.equal(await activities.count(), 4);
    await page.locator('.overview-range[data-days="30"]').click();
    assert.equal(
      await page.getByLabel("View Through", { exact: true }).inputValue(),
      dates.month,
    );
    assert.equal(await activities.count(), 6);
    assert.equal(await caseDeadlines.count(), 2);
    assert.equal(
      await page.getByText("Closed case writing", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByText("Already completed", { exact: true }).count(),
      0,
    );
    await page.locator('.overview-range[data-days="7"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await assertFits(
      page,
      "The date window, prominent urgency, and submission queue fit a phone.",
    );
    await screenshot(page, "overview-deadlines-mobile");
    await ready
      .locator(
        '[data-action="overview-submit"][data-id="' + dates.taskId + '"]',
      )
      .click();
    await waitTask(page, "Deadline Patient", "Future report ready", {
      done: true,
      written: true,
    });
    assert.equal(await ready.count(), 0);
    const updated = await record(page, "Deadline Patient");
    assert.equal(updated.status, "in_progress");
    assert.equal(updated.tasks.filter((task) => task.done).length, 2);
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Coming Up", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "What’s Coming Up.", exact: true })
      .waitFor();
    assert.equal(await page.locator(".overview-page").count(), 0);
    await assertFits(page, "Coming Up remains usable on a phone.");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  },
);

test(
  "upgrading and refreshing fictional examples preserve real cases, evidence bytes, and customized templates",
  options,
  async (t) => {
    const { page, dialog, errors, external } = await workspace(t);
    const fixture = await page.evaluate(async () => {
      const M = WWModel,
        today = M.today();
      const preferences = await WWStore.getSettings();
      const custom = M.newTemplate({
        name: "Preserved Custom Plan",
        activities: [
          {
            id: M.uid(),
            title: "Custom patient follow-up",
            week: 3,
            optional: false,
          },
        ],
      });
      const real = M.createCase({
        name: "Preserved Real Patient",
        startDate: M.addDays(today, -35),
        dueDate: M.addDays(today, 28),
        notes:
          "Keep this patient note exactly: <follow-up> & supporting evidence.",
        template: custom.activities,
        templateId: custom.id,
        templateName: custom.name,
      });
      real.tasks[0].dueDate = M.addDays(today, 10);
      const fileId = M.uid(),
        revision = M.uid(),
        oldFileId = M.uid();
      const evidence =
        "FICTIONAL TEST EVIDENCE\nPreserve these bytes through an example refresh.\n";
      real.attachments.push(
        {
          id: M.uid(),
          kind: "file",
          name: "Preserved evidence.txt",
          fileId,
          size: new TextEncoder().encode(evidence).byteLength,
          createdAt: real.createdAt,
        },
        {
          id: M.uid(),
          kind: "paper",
          name: "Signed original",
          value: "Cabinet B, private patient folder",
          createdAt: real.createdAt,
        },
        {
          id: M.uid(),
          kind: "drive",
          name: "Supporting Google Doc",
          value:
            "https://docs.google.com/document/d/fictional-preserved-record/edit",
          createdAt: real.createdAt,
        },
      );
      const legacy = M.makeDemo();
      for (const example of legacy) {
        for (const activity of example.tasks) {
          delete activity.endWeek;
          delete activity.requiresSubmission;
          delete activity.written;
          activity.dueDate = M.taskDue(
            example.startDate,
            example.dueDate,
            activity.week,
          );
        }
        example.notes = [
          {
            id: M.uid(),
            text: "An older fictional example.",
            createdAt: example.createdAt,
          },
        ];
      }
      const oldBlob = new Blob(["An obsolete example upload."], {
        type: "text/plain",
      });
      legacy[0].attachments.push({
        id: M.uid(),
        kind: "file",
        name: "Old example.txt",
        fileId: oldFileId,
        size: oldBlob.size,
        createdAt: legacy[0].createdAt,
      });
      await WWStore.importSync({
        cases: [real, ...legacy],
        settings: {
          ...preferences,
          initialized: true,
          demo: true,
          demoVersion: 1,
          templates: [...M.getTemplates(preferences), custom],
          defaultTemplateId: custom.id,
        },
        files: [
          {
            id: fileId,
            revision,
            blob: new Blob([evidence], { type: "text/plain" }),
          },
          { id: oldFileId, revision: M.uid(), blob: oldBlob },
        ],
      });
      return {
        real,
        custom,
        evidence,
        fileId,
        revision,
        oldFileId,
        oldIds: legacy.map((example) => example.id),
      };
    });
    async function assertRealPreserved() {
      const saved = await page.evaluate(
        async ({ realId, fileId, customId }) => {
          const snapshot = await WWStore.exportSync();
          const file = snapshot.files.find((entry) => entry.id === fileId);
          return {
            record: snapshot.cases.find((entry) => entry.id === realId),
            custom: WWModel.getTemplates(snapshot.settings).find(
              (entry) => entry.id === customId,
            ),
            defaultTemplateId: snapshot.settings.defaultTemplateId,
            text: file ? await file.blob.text() : null,
            revision: file?.revision,
          };
        },
        {
          realId: fixture.real.id,
          fileId: fixture.fileId,
          customId: fixture.custom.id,
        },
      );
      assert.deepEqual(
        saved.record,
        fixture.real,
        "Refreshing examples preserves the complete real record, including custom dates, notes, and references.",
      );
      assert.deepEqual(
        saved.custom,
        fixture.custom,
        "Customized templates remain unchanged.",
      );
      assert.equal(saved.defaultTemplateId, fixture.custom.id);
      assert.equal(
        saved.text,
        fixture.evidence,
        "The real evidence Blob survives with identical bytes.",
      );
      assert.equal(saved.revision, fixture.revision);
    }
    await page.reload();
    await page
      .getByRole("heading", { name: "At a Glance", exact: true })
      .waitFor();
    await page.waitForFunction(
      async () => (await WWStore.getSettings()).demoVersion === 2,
    );
    let saved = await records(page);
    let examples = saved.filter((entry) => entry.demo);
    assert.equal(saved.length, 7);
    assert.equal(examples.length, 6);
    assert.ok(
      examples.every((entry) => !fixture.oldIds.includes(entry.id)),
      "Old fictional cases are replaced on the local version upgrade.",
    );
    assert.deepEqual(
      ["open", "in_progress", "completed"].map(
        (status) => examples.filter((entry) => entry.status === status).length,
      ),
      [2, 2, 2],
    );
    assert.ok(
      examples.some((entry) =>
        entry.tasks.some(
          (activity) => (activity.endWeek ?? activity.week) > activity.week,
        ),
      ),
      "The upgraded examples demonstrate activities spanning weeks.",
    );
    const staged = examples
      .flatMap((entry) => entry.tasks)
      .filter((activity) => activity.requiresSubmission);
    assert.ok(staged.some((activity) => !activity.written && !activity.done));
    assert.ok(staged.some((activity) => activity.written && !activity.done));
    assert.ok(staged.some((activity) => activity.written && activity.done));
    await assertRealPreserved();
    assert.equal(
      await page.evaluate(
        async (id) => Boolean(await WWStore.getFile(id)),
        fixture.oldFileId,
      ),
      false,
      "Obsolete fictional uploads are removed.",
    );
    assert.equal(
      await page.evaluate(
        async () => (await WWStore.exportSync()).files.length,
      ),
      3,
      "The real upload and two new sample uploads remain.",
    );
    await page
      .getByRole("button", { name: "Refresh Examples", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Refresh Examples", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      async (oldIds) =>
        (await WWStore.getCases())
          .filter((entry) => entry.demo)
          .every((entry) => !oldIds.includes(entry.id)),
      examples.map((entry) => entry.id),
    );
    saved = await records(page);
    examples = saved.filter((entry) => entry.demo);
    assert.equal(saved.length, 7);
    assert.equal(
      examples.length,
      6,
      "Manual refresh replaces the examples without duplicating them.",
    );
    await assertRealPreserved();
    assert.equal(
      await page.evaluate(
        async () => (await WWStore.exportSync()).files.length,
      ),
      3,
    );
    await screenshot(page, "refreshed-examples-desktop");
    await page
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await records(page)).length, 1);
    await assertRealPreserved();
    assert.equal(
      await page.evaluate(
        async () => (await WWStore.exportSync()).files.length,
      ),
      1,
      "Removing examples deletes only their uploaded files.",
    );
    await page.reload();
    await page
      .getByRole("heading", { name: "At a Glance", exact: true })
      .waitFor();
    assert.equal(
      (await records(page)).length,
      1,
      "Removed examples stay removed after reload.",
    );
    assert.equal(await page.locator(".demo-banner").count(), 0);
    await assertRealPreserved();
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  },
);

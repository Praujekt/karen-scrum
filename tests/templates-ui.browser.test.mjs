/** Template libraries create independent patient plans and survive backups. */
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
  "template library creates independent cases, copies templates, and survives reload and backup restore",
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
      if (!type) continue;
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
      acceptDownloads: true,
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
    const records = () => page.evaluate(() => WWStore.getCases());
    const templateByName = async (name) =>
      (await library()).find((template) => template.name === name);
    const caseByName = async (name) =>
      (await records()).find((record) => record.name === name);
    async function openLibrary() {
      await sidebar
        .getByRole("button", { name: "Activity Templates", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Activity Templates", exact: true })
        .waitFor();
    }
    async function selectTemplate(name) {
      await page
        .getByRole("button", { name: "Select Template: " + name, exact: true })
        .click();
    }
    async function createCase(name, templateName) {
      await sidebar.getByRole("button", { name: /^All Cases\s*\d*$/ }).click();
      await page.getByRole("button", { name: "New Case", exact: true }).click();
      await dialog.getByLabel("Patient Name", { exact: false }).fill(name);
      await dialog
        .getByLabel("Case Opened", { exact: true })
        .fill("2040-11-01");
      await dialog
        .getByLabel("Final Due Date", { exact: false })
        .fill("2040-12-31");
      await dialog
        .getByLabel("Template", { exact: true })
        .selectOption((await templateByName(templateName)).id);
      await dialog
        .getByRole("button", { name: "Create Case", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("heading", { name, exact: true }).waitFor();
    }
    async function editActivity(oldTitle, newTitle) {
      await page
        .getByRole("button", {
          name: new RegExp("^Edit(?: Template)? " + oldTitle + "$", "i"),
        })
        .click();
      await dialog.getByLabel("Activity Name", { exact: true }).fill(newTitle);
      await dialog
        .getByRole("button", { name: "Save Activity", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
    }

    await page.goto(base);
    await page.getByRole("button", { name: "New Case", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Remove Examples", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await openLibrary();
    assert.deepEqual(
      (await library()).map((template) => template.name),
      ["Default"],
    );
    assert.equal((await templateByName("Default")).activities.length, 19);

    await page
      .getByRole("button", { name: "New Template", exact: true })
      .click();
    await dialog
      .getByLabel("Template Name", { exact: true })
      .fill("Focused Assessment");
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
      .fill("Classroom Follow-Up");
    await dialog.getByLabel("Plan Week", { exact: true }).selectOption("2");
    await dialog
      .getByRole("button", { name: "Add Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      (await templateByName("Focused Assessment")).activities.map(
        (activity) => [activity.title, activity.week],
      ),
      [["Classroom Follow-Up", 2]],
    );

    await createCase("Template Case One", "Focused Assessment");
    let first = await caseByName("Template Case One");
    assert.equal(first.tasks.length, 1);
    assert.equal(first.tasks[0].dueDate, "2040-12-10");
    assert.equal(first.sourceTemplateName, "Focused Assessment");
    await editActivity("Classroom Follow-Up", "Case-Only Follow-Up");
    assert.equal(
      (await caseByName("Template Case One")).tasks[0].title,
      "Case-Only Follow-Up",
    );
    assert.equal(
      (await templateByName("Focused Assessment")).activities[0].title,
      "Classroom Follow-Up",
    );

    await openLibrary();
    await selectTemplate("Focused Assessment");
    await editActivity("Classroom Follow-Up", "Revised Template Follow-Up");
    assert.equal(
      (await caseByName("Template Case One")).tasks[0].title,
      "Case-Only Follow-Up",
    );
    await createCase("Template Case Two", "Focused Assessment");
    const second = await caseByName("Template Case Two");
    assert.equal(second.tasks[0].title, "Revised Template Follow-Up");
    assert.notEqual(first.tasks[0].id, second.tasks[0].id);

    await openLibrary();
    await selectTemplate("Focused Assessment");
    await page
      .getByRole("button", { name: "Copy Template", exact: true })
      .click();
    await dialog
      .getByLabel("Template Name", { exact: true })
      .fill("Focused Assessment Copy");
    await dialog
      .getByRole("button", { name: "Create Copy", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "Add Activity", exact: true })
      .first()
      .click();
    await dialog
      .getByLabel("Activity Name", { exact: true })
      .fill("Additional Record Review");
    await dialog.getByLabel("Plan Week", { exact: true }).selectOption("1");
    await dialog
      .getByRole("button", { name: "Add Activity", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      (await templateByName("Focused Assessment Copy")).activities.length,
      2,
    );
    assert.equal(
      (await templateByName("Focused Assessment")).activities.length,
      1,
    );
    assert.notEqual(
      (await templateByName("Focused Assessment Copy")).activities[0].id,
      (await templateByName("Focused Assessment")).activities[0].id,
    );
    await page
      .getByRole("button", { name: "Edit Template", exact: true })
      .click();
    await dialog
      .getByLabel("Template Name", { exact: true })
      .fill("Focused Assessment Copy Revised");
    await dialog
      .getByRole("button", { name: /^Save (?:Template|Changes)$/, exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.reload();
    await page
      .getByRole("heading", { name: "Activity Templates", exact: true })
      .waitFor();
    assert.deepEqual(
      (await library()).map((template) => template.name),
      ["Default", "Focused Assessment", "Focused Assessment Copy Revised"],
    );

    await sidebar
      .getByRole("button", { name: "Reminders & Settings", exact: true })
      .click();
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download Backup", exact: true })
      .click();
    const backupPath = await (await downloaded).path();
    const backup = JSON.parse(await readFile(backupPath, "utf8"));
    assert.deepEqual(
      backup.settings.templates.map((template) => template.name),
      ["Default", "Focused Assessment", "Focused Assessment Copy Revised"],
    );
    assert.deepEqual(
      backup.cases.map((record) => record.tasks[0].title).sort(),
      ["Case-Only Follow-Up", "Revised Template Follow-Up"],
    );
    await createCase("Template Case Three", "Focused Assessment Copy Revised");
    await openLibrary();
    await selectTemplate("Focused Assessment Copy Revised");
    await page
      .getByRole("button", { name: "Delete Template", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Delete Template", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await library()).length, 2);
    assert.equal(
      (await caseByName("Template Case Three")).tasks.length,
      2,
      "Deleting a template preserves plans already created from it.",
    );
    await sidebar
      .getByRole("button", { name: "Reminders & Settings", exact: true })
      .click();
    await page.getByRole("button", { name: /^Clear Workspace/ }).click();
    await dialog
      .getByRole("button", { name: "Clear Everything", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator("#restore-file").setInputFiles(backupPath);
    await dialog
      .getByRole("button", { name: "Restore Backup", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await openLibrary();
    assert.equal((await library()).length, 3);
    assert.equal(
      (await templateByName("Focused Assessment Copy Revised")).activities
        .length,
      2,
    );
    assert.equal((await records()).length, 2);
    assert.equal(
      (await caseByName("Template Case One")).tasks[0].title,
      "Case-Only Follow-Up",
    );
    if (process.env.KARENS_LOAD_SCREENSHOTS === "1") {
      await mkdir(new URL("../.qa-artifacts/", import.meta.url), {
        recursive: true,
      });
      await selectTemplate("Focused Assessment Copy Revised");
      await page.screenshot({
        path: fileURLToPath(
          new URL(
            "../.qa-artifacts/template-library-desktop.png",
            import.meta.url,
          ),
        ),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Template library fits a phone viewport.",
    );
    if (process.env.KARENS_LOAD_SCREENSHOTS === "1") {
      await page.screenshot({
        path: fileURLToPath(
          new URL(
            "../.qa-artifacts/template-library-mobile.png",
            import.meta.url,
          ),
        ),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  },
);

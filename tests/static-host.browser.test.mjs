/** Static subpath hosting with real browser storage and no backend API. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";

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
  "static subpath hosting supports local case CRUD without a reminder API",
  {
    skip: !chromium ? "Optional Playwright library is not installed." : false,
    timeout: 120000,
  },
  async (t) => {
    const assets = new Map();
    for (const name of await readdir(new URL("../dist/", import.meta.url))) {
      const extension = name.split(".").pop();
      const type = {
        html: "text/html",
        css: "text/css",
        js: "text/javascript",
        svg: "image/svg+xml",
      }[extension];
      if (!type) continue;
      assets.set("/karen-scrum/" + (name === "index.html" ? "" : name), {
        content: await readFile(new URL("../dist/" + name, import.meta.url)),
        type,
      });
    }
    const requests = [];
    const server = createServer((request, response) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      requests.push(pathname);
      const asset = assets.get(pathname);
      if (!asset) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Static files only; no API is configured.");
        return;
      }
      response.writeHead(200, {
        "Content-Type": asset.type,
        "Cache-Control": "no-store",
      });
      response.end(asset.content);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
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
    });
    const page = await context.newPage();
    const origin = "http://127.0.0.1:" + server.address().port;
    const externalRequests = [],
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        externalRequests.push(url.href);
        await route.abort();
      } else await route.continue();
    });

    const response = await page.goto(origin + "/karen-scrum/");
    assert.equal(response.status(), 200);
    const dialog = page.getByRole("dialog");
    await page.getByRole("button", { name: "New Case", exact: true }).click();
    await dialog.getByLabel("Patient Name").fill("Static hosting test patient");
    await dialog.getByLabel("Case Opened").fill("2040-11-01");
    await dialog.getByLabel("Final Due Date").fill("2040-12-31");
    await dialog
      .getByRole("button", { name: "Create Case", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Static hosting test patient",
        exact: true,
      })
      .waitFor();
    const caseId = await page.evaluate(
      async () =>
        (await WWStore.getCases()).find(
          (c) => c.name === "Static hosting test patient",
        ).id,
    );
    await page.locator("[data-task-check]").first().check();
    await page.waitForFunction(
      async (id) =>
        (await WWStore.getCases()).find((c) => c.id === id).tasks[0].done,
      caseId,
    );
    await page.getByRole("button", { name: "Edit Case", exact: true }).click();
    await dialog
      .getByLabel("Patient Name")
      .fill("Updated static hosting patient");
    await dialog
      .getByRole("button", { name: "Save Case", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Updated static hosting patient",
        exact: true,
      })
      .waitFor();
    await page.reload();
    await page
      .getByRole("heading", {
        name: "Updated static hosting patient",
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator("[data-task-check]:checked").count(), 1);
    assert.equal(
      await page.evaluate(
        async (id) =>
          (await WWStore.getCases()).find((c) => c.id === id).tasks[0].dueDate,
        caseId,
      ),
      "2040-12-03",
    );
    await page
      .getByRole("button", { name: "Delete Case", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Delete Case", exact: true })
      .click();
    await page.waitForFunction(
      async (id) => !(await WWStore.getCases()).some((c) => c.id === id),
      caseId,
    );
    await page.reload();
    await page.getByRole("button", { name: "New Case", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        async (id) => (await WWStore.getCases()).some((c) => c.id === id),
        caseId,
      ),
      false,
    );

    for (const name of [
      "styles.css",
      "model.js",
      "data.js",
      "reminder-client.js",
      "app.js",
    ]) {
      assert.ok(
        requests.includes("/karen-scrum/" + name),
        name + " must load relative to the project path.",
      );
      assert.ok(
        !requests.includes("/" + name),
        name + " must not assume a root deployment.",
      );
    }
    assert.deepEqual(
      externalRequests,
      [],
      "No cloud service may be contacted without configuration.",
    );
    assert.deepEqual(errors, []);
  },
);

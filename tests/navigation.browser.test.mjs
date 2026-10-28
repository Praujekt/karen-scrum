/** Sidebar case folders use the same persistent route as case filters and metrics. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
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
  "case folders filter consistently, survive history/reload, and fit the mobile sidebar",
  {
    skip: !chromium ? "Optional Playwright library is not installed." : false,
    timeout: 60000,
  },
  async (t) => {
    const assets = new Map();
    for (const name of await readdir(new URL("../dist/", import.meta.url))) {
      const extension = name.split(".").pop();
      const type = {
        html: "text/html; charset=utf-8",
        css: "text/css; charset=utf-8",
        js: "text/javascript; charset=utf-8",
        svg: "image/svg+xml",
      }[extension];
      if (!type) continue;
      assets.set("/karen-scrum/" + (name === "index.html" ? "" : name), {
        body: await readFile(new URL("../dist/" + name, import.meta.url)),
        type,
      });
    }
    const server = createServer((request, response) => {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const asset = assets.get(pathname);
      response.writeHead(asset ? 200 : 404, {
        "Content-Type": asset?.type || "text/plain",
        "Cache-Control": "no-store",
      });
      response.end(asset?.body || "Static hosting only.");
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
        ? {
            executablePath,
            headless: true,
          }
        : { channel: "chrome", headless: true },
    );
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      timezoneId: "America/Los_Angeles",
    });
    const page = await context.newPage();
    const base = `http://127.0.0.1:${server.address().port}/karen-scrum/`;
    const errors = [],
      externalRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== new URL(base).origin) {
        externalRequests.push(route.request().url());
        await route.abort();
      } else await route.continue();
    });
    await page.goto(base);
    await page.getByRole("button", { name: /^New Case$/i }).waitFor();
    const sidebar = page.locator(".sidebar");
    const folders = {
      "not-started": /^Not Started\s*\d*$/i,
      "in-progress": /^In[- ]progress\s*\d*$/i,
      completed: /^Completed\s*\d*$/i,
    };
    const modelStatuses = {
      "not-started": "open",
      "in-progress": "in_progress",
      completed: "completed",
    };
    const folder = (name) =>
      sidebar.getByRole("button", { name: folders[name] });
    async function assertFolder(name) {
      await page.waitForURL(base + "#cases/" + name);
      await page.waitForFunction(
        () => document.querySelectorAll(".case-card").length === 2,
      );
      const shownIds = await page
        .locator(".case-card")
        .evaluateAll((cards) => cards.map((card) => card.dataset.id).sort());
      const expectedIds = await page.evaluate(
        async (status) =>
          (await WWStore.getCases())
            .filter((record) => record.status === status)
            .map((record) => record.id)
            .sort(),
        modelStatuses[name],
      );
      assert.deepEqual(shownIds, expectedIds, name + " shows its own cases.");
      assert.equal(
        await page.getByLabel(/^Filter Cases$/i).inputValue(),
        modelStatuses[name],
      );
      assert.equal(await folder(name).getAttribute("aria-current"), "page");
      assert.equal(await sidebar.locator('[aria-current="page"]').count(), 1);
      await page.getByText("Cases Due Soon", { exact: true }).waitFor();
    }

    assert.match(
      (await sidebar.locator(".brand").innerText()).replace(/’/g, "'"),
      /Karen's\s+Load/,
    );
    await page
      .getByRole("heading", { name: "At a Glance", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("View Through", { exact: true }).inputValue(),
      await page.evaluate(() => WWModel.addDays(WWModel.today(), 7)),
      "Overview starts with the next seven days in Pacific Time.",
    );
    await sidebar
      .getByRole("button", { name: "Coming Up", exact: true })
      .waitFor();
    await sidebar
      .getByRole("button", { name: "Activity Templates", exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".case-card").count(),
      0,
      "Overview presents actionable deadlines rather than the Cases list.",
    );
    assert.equal(await page.getByLabel(/^Filter Cases$/i).count(), 0);
    if (process.env.KARENS_LOAD_SCREENSHOTS === "1") {
      await mkdir(new URL("../.qa-artifacts/", import.meta.url), {
        recursive: true,
      });
      await page.screenshot({
        path: fileURLToPath(
          new URL(
            "../.qa-artifacts/karen-load-sidebar-desktop.png",
            import.meta.url,
          ),
        ),
        fullPage: true,
      });
    }
    for (const name of ["not-started", "in-progress", "completed"]) {
      const count = await folder(name).locator(".nav-count").innerText();
      assert.equal(count, "2");
      await folder(name).click();
      await assertFolder(name);
    }
    await page.goBack();
    await assertFolder("in-progress");
    await page.goBack();
    await assertFolder("not-started");
    await page.goForward();
    await assertFolder("in-progress");
    await page.reload();
    await assertFolder("in-progress");

    // Returning to the parent folder clears the previous status restriction.
    await page.locator(".case-card").first().click();
    await sidebar.getByRole("button", { name: /^All cases\s*\d*$/i }).click();
    await page.waitForURL(base + "#cases");
    assert.equal(await page.locator(".case-card").count(), 6);
    assert.equal(await page.getByLabel(/^Filter Cases$/i).inputValue(), "all");
    assert.equal(
      await sidebar
        .getByRole("button", { name: /^All cases\s*\d*$/i })
        .getAttribute("aria-current"),
      "page",
    );

    // Existing bookmarked Open-folder URLs remain usable after its label changed.
    await page.goto(base + "#cases/open");
    await page.waitForFunction(
      () => document.querySelector("#case-filter")?.value === "open",
    );
    assert.equal(await page.locator(".case-card").count(), 2);
    assert.equal(
      await folder("not-started").getAttribute("aria-current"),
      "page",
    );

    // Existing filter controls and metric cards select the same child folders.
    await page.getByLabel(/^Filter Cases$/i).selectOption("completed");
    await assertFolder("completed");
    await page.locator('.stat-card[data-filter="open"]').click();
    await assertFolder("not-started");
    await page
      .getByRole("searchbox", { name: /^Search Patients$/i })
      .fill("no matching name");
    assert.equal(await page.locator(".case-card").count(), 0);
    await folder("in-progress").click();
    await assertFolder("in-progress");
    assert.equal(
      await page
        .getByRole("searchbox", { name: /^Search Patients$/i })
        .inputValue(),
      "",
    );

    await sidebar
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "At a Glance", exact: true })
      .waitFor();
    assert.equal(await page.locator(".case-card").count(), 0);
    await folder("completed").click();
    await assertFolder("completed");
    await page.goBack();
    await page.waitForURL(base + "#overview");
    await page
      .getByRole("heading", { name: "At a Glance", exact: true })
      .waitFor();
    assert.equal(
      await page.locator(".case-card").count(),
      0,
      "Returning to Overview restores the deadline view.",
    );
    assert.equal(await page.getByLabel(/^Filter Cases$/i).count(), 0);

    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `The navigation does not overflow at ${width}px.`,
      );
      assert.ok(
        await sidebar.locator(".brand-name").evaluate((element) => {
          const brand = element.getBoundingClientRect();
          const aside = element.closest(".sidebar").getBoundingClientRect();
          return brand.left >= aside.left && brand.right <= aside.right + 1;
        }),
        `The longer brand fits the sidebar at ${width}px.`,
      );
      for (const name of ["not-started", "in-progress", "completed"]) {
        await folder(name).click();
        await assertFolder(name);
      }
      if (width === 390 && process.env.KARENS_LOAD_SCREENSHOTS === "1") {
        await page.screenshot({
          path: fileURLToPath(
            new URL(
              "../.qa-artifacts/karen-load-sidebar-mobile.png",
              import.meta.url,
            ),
          ),
          fullPage: true,
        });
      }
    }
    if (process.env.KARENS_LOAD_SCREENSHOTS === "1") {
      await sidebar
        .getByRole("button", { name: /^Reminders & Settings$/i })
        .click();
      await page
        .getByRole("heading", {
          name: "A Little Help Remembering.",
          exact: true,
        })
        .waitFor();
      for (const [width, suffix] of [
        [1365, "desktop"],
        [390, "mobile"],
      ]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await page.screenshot({
          path: fileURLToPath(
            new URL(
              `../.qa-artifacts/karen-load-settings-${suffix}.png`,
              import.meta.url,
            ),
          ),
          fullPage: true,
        });
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
  },
);

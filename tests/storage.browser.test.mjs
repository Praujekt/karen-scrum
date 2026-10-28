/** Optional real-IndexedDB quota checks; application runtime has no dependencies. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

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
  "IndexedDB evidence budget is atomic, preserves files on rejection, and counts replacement deltas",
  {
    skip: !chromium ? "Optional Playwright library is not installed." : false,
    timeout: 120000,
  },
  async (t) => {
    const dataSource = await readFile(
      new URL("../dist/data.js", import.meta.url),
    );
    const server = createServer((request, response) => {
      response.writeHead(200, {
        "Content-Type":
          request.url === "/data.js" ? "text/javascript" : "text/html",
      });
      response.end(
        request.url === "/data.js"
          ? dataSource
          : '<!doctype html><script src="/data.js"></script>',
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
    });
    browser = await chromium.launch(
      process.env.WEEKWISE_BROWSER_EXECUTABLE
        ? {
            executablePath: process.env.WEEKWISE_BROWSER_EXECUTABLE,
            headless: true,
          }
        : { channel: "chrome", headless: true },
    );
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port);
    const results = await page.evaluate(async () => {
      const DB = window.WWStore,
        MB = 1024 * 1024;
      const blob = (size) => new Blob([new Uint8Array(size)]);
      await DB.init();
      for (let index = 1; index <= 4; index++)
        await DB.putFile({ id: "file-" + index, blob: blob(25 * MB) });
      let overflowError;
      try {
        await DB.putFile({ id: "overflow", blob: blob(1) });
      } catch (error) {
        overflowError = error.message;
      }
      const preservedSize = (await DB.getFile("file-1")).size;
      const overflowExists = !!(await DB.getFile("overflow"));
      await DB.putFile({ id: "file-1", blob: blob(24 * MB) });
      const attempts = await Promise.allSettled([
        DB.putFile({ id: "candidate-a", blob: blob(MB) }),
        DB.putFile({ id: "candidate-b", blob: blob(MB) }),
      ]);
      let oversizedError;
      try {
        await DB.putFile({ id: "file-1", blob: blob(26 * MB) });
      } catch (error) {
        oversizedError = error.message;
      }
      const replacementSize = (await DB.getFile("file-1")).size;
      const candidateSizes = [
        (await DB.getFile("candidate-a"))?.size || 0,
        (await DB.getFile("candidate-b"))?.size || 0,
      ];
      await DB.clearAll();
      return {
        overflowError,
        preservedSize,
        overflowExists,
        statuses: attempts.map((result) => result.status).sort(),
        oversizedError,
        replacementSize,
        candidateSizes,
      };
    });
    assert.match(results.overflowError, /100 MB workspace limit/);
    assert.equal(results.preservedSize, 25 * 1024 * 1024);
    assert.equal(results.overflowExists, false);
    assert.deepEqual(results.statuses, ["fulfilled", "rejected"]);
    assert.match(results.oversizedError, /25 MB or less/);
    assert.equal(results.replacementSize, 24 * 1024 * 1024);
    assert.equal(
      results.candidateSizes.reduce((a, b) => a + b, 0),
      1024 * 1024,
    );
    // GitHub project paths must not accidentally open each other's database;
    // the host-root database retains its original name and records.
    await page.evaluate(() => WWStore.saveSettings({ namespace: "root" }));
    const projectA = await context.newPage();
    await projectA.goto('http://127.0.0.1:' + server.address().port + '/project-a/');
    assert.deepEqual(await projectA.evaluate(() => WWStore.getSettings()), {});
    await projectA.evaluate(() => WWStore.saveSettings({ namespace: "project-a" }));
    const projectB = await context.newPage();
    await projectB.goto('http://127.0.0.1:' + server.address().port + '/project-b/');
    assert.deepEqual(await projectB.evaluate(() => WWStore.getSettings()), {});
    await projectB.evaluate(() => WWStore.saveSettings({ namespace: "project-b" }));
    await page.reload();
    assert.deepEqual(await page.evaluate(() => WWStore.getSettings()), { namespace: "root" });
    await projectA.reload();
    assert.deepEqual(await projectA.evaluate(() => WWStore.getSettings()), { namespace: "project-a" });
  },
);

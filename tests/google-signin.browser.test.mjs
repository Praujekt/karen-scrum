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
  "Google sign-in loads only on request, checks its nonce, and allows cancellation/retry",
  {
    skip: !chromium ? "Optional Playwright library is not installed." : false,
    timeout: 30000,
  },
  async (t) => {
    const source = await readFile(
      new URL("../dist/google-signin.js", import.meta.url),
    );
    const server = createServer((request, response) => {
      response.writeHead(200, {
        "Content-Type":
          request.url === "/google-signin.js" ? "text/javascript" : "text/html",
      });
      response.end(
        request.url === "/google-signin.js"
          ? source
          : '<!doctype html><script src="/google-signin.js"></script>',
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
    const page = await browser.newPage();
    let requests = 0;
    await page.route("https://accounts.google.com/**", async (route) => {
      requests++;
      await route.fulfill({
        contentType: "text/javascript",
        body: `window.google = {accounts:{id:{
      initialize: function(options){ window.mockGoogleOptions = options; },
      renderButton: function(host){ const button=document.createElement('button'); button.textContent='Mock Google account';
        button.onclick=function(){ const claims={nonce:window.wrongNonce?'wrong':window.mockGoogleOptions.nonce};
          window.mockGoogleOptions.callback({credential:btoa('{}')+'.'+btoa(JSON.stringify(claims))+'.mock'}); };
        host.appendChild(button); }
    }}};`,
      });
    });
    await page.goto("http://127.0.0.1:" + server.address().port);
    assert.equal(
      requests,
      0,
      "Loading the local helper never contacts Google.",
    );
    assert.match(
      await page.evaluate(() =>
        WWGoogle.signIn("bad-client").catch((e) => e.message),
      ),
      /Google web client ID/,
    );
    assert.equal(requests, 0);
    await page.evaluate(() => {
      window.signInResult = WWGoogle.signIn(
        "test.apps.googleusercontent.com",
      ).catch((e) => ({ error: e.message }));
    });
    await page.getByRole("button", { name: "Mock Google account" }).click();
    assert.equal(
      typeof (await page.evaluate(() => window.signInResult)),
      "string",
    );
    assert.equal(requests, 1);
    await page.evaluate(() => {
      window.wrongNonce = true;
      window.signInResult = WWGoogle.signIn(
        "test.apps.googleusercontent.com",
      ).catch((e) => ({ error: e.message }));
    });
    await page.getByRole("button", { name: "Mock Google account" }).click();
    assert.match(
      (await page.evaluate(() => window.signInResult)).error,
      /invalid response/,
    );
    await page.evaluate(() => {
      window.signInResult = WWGoogle.signIn(
        "test.apps.googleusercontent.com",
      ).catch((e) => ({ error: e.message }));
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.match(
      (await page.evaluate(() => window.signInResult)).error,
      /cancelled/,
    );
    assert.equal(await page.locator("dialog").count(), 0);
  },
);

/** Browser crypto client against the shipped Worker source with local D1/R2 adapters. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createCloudReminderWorker } from "../cloud-reminders/worker.mjs";

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
  "browser sync interoperates with the shipped Worker metadata, binary files, authentication, and CORS",
  {
    skip: !chromium ? "Optional Playwright library is not installed." : false,
    timeout: 120000,
  },
  async (t) => {
    const source = new Map();
    for (const name of ["model.js", "data.js", "workspace-sync.js"])
      source.set(
        "/" + name,
        await readFile(new URL("../dist/" + name, import.meta.url)),
      );
    const server = createServer((request, response) => {
      response.writeHead(200, {
        "Content-Type": source.has(request.url)
          ? "text/javascript"
          : "text/html",
      });
      response.end(
        source.get(request.url) ||
          '<!doctype html><script src="/model.js"></script><script src="/data.js"></script><script src="/workspace-sync.js"></script>',
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      await readFile(
        new URL("../cloud-reminders/schema.sql", import.meta.url),
        "utf8",
      ),
    );
    const statement = (sql, values = []) => ({
      bind(...args) {
        return statement(sql, args);
      },
      async first() {
        return sqlite.prepare(sql).get(...values) || null;
      },
      async all() {
        return { success: true, results: sqlite.prepare(sql).all(...values) };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      rows() {
        return sqlite.prepare(sql).all(...values);
      },
    });
    const objects = new Map();
    const FILES = {
      async put(key, value, options = {}) {
        const bytes =
          typeof value === "string"
            ? new TextEncoder().encode(value)
            : new Uint8Array(value);
        objects.set(key, {
          bytes: bytes.slice(),
          customMetadata: options.customMetadata || {},
        });
      },
      async head(key) {
        const value = objects.get(key);
        return value
          ? { size: value.bytes.length, customMetadata: value.customMetadata }
          : null;
      },
      async get(key) {
        const value = objects.get(key);
        return value
          ? {
              body: new Response(value.bytes.slice()).body,
              size: value.bytes.length,
              text: async () => new TextDecoder().decode(value.bytes),
            }
          : null;
      },
    };
    const origin = "http://127.0.0.1:" + server.address().port;
    const service = "https://weekwise-source-integration.example";
    const token = "integration-only-secret-key-0123456789-abcdef";
    const phrase = "integration encryption phrase 123";
    const env = {
      DB: {
        prepare: (sql) => statement(sql),
        async batch(statements) {
          sqlite.exec("BEGIN");
          try {
            const results = statements.map((statement) => ({
              success: true,
              results: statement.rows(),
            }));
            sqlite.exec("COMMIT");
            return results;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      },
      FILES,
      ALLOWED_ORIGIN: origin,
      REMINDER_SYNC_TOKEN: token,
    };
    const worker = createCloudReminderWorker({
      fetchImpl: async () => {
        throw new Error(
          "Live identity and messaging requests are forbidden in this test.",
        );
      },
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
      sqlite.close();
    });
    browser = await chromium.launch(
      process.env.WEEKWISE_BROWSER_EXECUTABLE
        ? {
            executablePath: process.env.WEEKWISE_BROWSER_EXECUTABLE,
            headless: true,
          }
        : { channel: "chrome", headless: true },
    );
    async function device() {
      const context = await browser.newContext();
      await context.route(service + "/**", async (route) => {
        const request = route.request();
        const response = await worker.fetch(
          new Request(request.url(), {
            method: request.method(),
            headers: request.headers(),
            body: ["GET", "HEAD", "OPTIONS"].includes(request.method())
              ? undefined
              : request.postDataBuffer(),
          }),
          env,
        );
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(async () => {
        await WWStore.init();
        window.sync = WWSync.create({ DB: WWStore });
      });
      return page;
    }
    const a = await device(),
      b = await device();
    const id = await a.evaluate(async () => {
      const c = WWModel.createCase({
        name: "Fictional worker integration patient",
      });
      const fileId = WWModel.uid(),
        blob = new Blob(["Worker integration evidence"], {
          type: "text/plain",
        });
      await WWStore.putFile({ id: fileId, blob });
      c.attachments.push({
        id: WWModel.uid(),
        name: "Evidence.txt",
        kind: "file",
        fileId,
        size: blob.size,
        createdAt: new Date().toISOString(),
      });
      await WWStore.saveCase(c);
      const completed = WWModel.createCase({
        name: "Fictional completed sample",
      });
      completed.status = "completed";
      await WWStore.saveCase(completed);
      const example = WWModel.createCase({ name: "Fictional demo sample" });
      example.demo = true;
      await WWStore.saveCase(example);
      return c.id;
    });
    await a.evaluate((input) => sync.connect(input), {
      url: service,
      token,
      passphrase: phrase,
    });
    let reminderRow = sqlite
      .prepare(
        "SELECT snapshot_json, snapshot_workspace_version FROM reminder_state",
      )
      .get();
    assert.equal(reminderRow.snapshot_workspace_version, 1);
    assert.equal(
      JSON.parse(reminderRow.snapshot_json).caseCount,
      1,
      "Completed and example cases are excluded.",
    );
    assert.equal(JSON.parse(reminderRow.snapshot_json).taskDueDates.length, 19);
    await b.evaluate((input) => sync.connect(input), {
      url: service,
      token,
      passphrase: phrase,
    });
    assert.equal(
      await b.evaluate(async (id) => {
        const c = (await WWStore.getCases()).find((c) => c.id === id);
        return (await WWStore.getFile(c.attachments[0].fileId)).text();
      }, id),
      "Worker integration evidence",
    );
    await b.evaluate(
      async (id) =>
        sync.withWrite(async () => {
          const c = (await WWStore.getCases()).find((c) => c.id === id);
          c.tasks[0].done = true;
          await WWStore.saveCase(c);
        }),
      id,
    );
    await a.evaluate(() => sync.refresh());
    assert.equal(
      await a.evaluate(
        async (id) =>
          (await WWStore.getCases()).find((c) => c.id === id).tasks[0].done,
        id,
      ),
      true,
    );
    assert.equal(
      sqlite.prepare("SELECT version FROM encrypted_workspace").get().version,
      2,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM encrypted_files").get()
        .count,
      1,
    );
    reminderRow = sqlite
      .prepare(
        "SELECT snapshot_json, snapshot_workspace_version FROM reminder_state",
      )
      .get();
    assert.equal(reminderRow.snapshot_workspace_version, 2);
    assert.equal(
      JSON.parse(reminderRow.snapshot_json).taskDueDates.length,
      18,
      "Phone edits update reminder dates without a separate reminder connection.",
    );
    for (const body of [
      { snapshot: { caseCount: 0, caseDueDates: [], taskDueDates: [] } },
      {
        snapshot: { caseCount: 0, caseDueDates: [], taskDueDates: [] },
        workspaceVersion: 1,
      },
    ]) {
      const rejected = await worker.fetch(
        new Request(service + "/snapshot", {
          method: "PUT",
          headers: {
            Authorization: "Bearer " + token,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        env,
      );
      assert.equal(
        rejected.status,
        409,
        "Missing or stale snapshot versions cannot overwrite the current shared reminder dates.",
      );
    }
    assert.equal(
      sqlite.prepare("SELECT snapshot_json FROM reminder_state").get()
        .snapshot_json,
      reminderRow.snapshot_json,
    );
    for (const object of objects.values()) {
      const bytes = Buffer.from(object.bytes);
      assert.ok(
        !bytes.includes(Buffer.from("Fictional worker integration patient")),
      );
      assert.ok(!bytes.includes(Buffer.from("Worker integration evidence")));
      assert.ok(!bytes.includes(Buffer.from(phrase)));
    }
  },
);

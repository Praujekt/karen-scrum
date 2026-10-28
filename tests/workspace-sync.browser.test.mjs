/** Real browser WebCrypto/IndexedDB, two isolated devices, mocked opaque backend. */
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
  "encrypted workspace sync shares cases/files and rejects conflicts, offline edits, and wrong passphrases",
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
    const origin = "http://127.0.0.1:" + server.address().port;
    const service = "https://sync.example.test";
    const token = "test-workspace-key-0123456789-abcdefghijklmnop";
    const phrase = "example encryption phrase 12345";
    const googleToken =
      "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJjbGllbnQifQ.fakeSignature0123456789";
    const cloud = {
      version: 0,
      payload: null,
      updatedAt: null,
      files: new Map(),
      uploads: 0,
      metadataWrites: [],
    };
    const errors = [];
    async function device() {
      const context = await browser.newContext();
      await context.route(service + "/**", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        const headers = {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET,PUT,OPTIONS",
          "access-control-allow-headers":
            "Authorization,Content-Type,X-Weekwise-Request",
        };
        const json = async (status, value) =>
          route.fulfill({
            status,
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(value),
          });
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers });
        if (
          !["Bearer " + token, "Bearer " + googleToken].includes(
            request.headers().authorization,
          )
        )
          return json(401, { error: "Unauthorized" });
        if (url.pathname === "/workspace") {
          if (request.method() === "GET")
            return json(200, {
              version: cloud.version,
              payload: cloud.payload,
              updatedAt: cloud.updatedAt,
            });
          const value = request.postDataJSON();
          if (value.expectedVersion !== cloud.version)
            return json(409, { error: "Conflict", version: cloud.version });
          cloud.metadataWrites.push(structuredClone(value));
          cloud.version++;
          cloud.payload = value.payload;
          cloud.updatedAt = new Date().toISOString();
          return json(200, {
            version: cloud.version,
            updatedAt: cloud.updatedAt,
          });
        }
        if (url.pathname.startsWith("/files/")) {
          const id = url.pathname.slice(7);
          if (request.method() === "GET") {
            const bytes = cloud.files.get(id);
            return bytes
              ? route.fulfill({
                  status: 200,
                  headers: {
                    ...headers,
                    "content-type": "application/octet-stream",
                  },
                  body: bytes,
                })
              : json(404, { error: "Missing file" });
          }
          const bytes = request.postDataBuffer();
          if (cloud.files.has(id) && !cloud.files.get(id).equals(bytes))
            return json(409, { error: "Immutable file" });
          cloud.files.set(id, bytes);
          cloud.uploads++;
          return json(200, { saved: true });
        }
        return json(404, { error: "Unknown path" });
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await page.evaluate(async () => {
        await WWStore.init();
        window.sync = WWSync.create({ DB: WWStore });
      });
      return { context, page };
    }
    const a = await device(),
      b = await device();
    const id = await a.page.evaluate(async () => {
      const c = WWModel.createCase({
        name: "Fictional encrypted patient",
        startDate: "2040-11-01",
        dueDate: "2040-12-31",
        notes: "Private sample case note",
      });
      const fileId = WWModel.uid();
      await WWStore.putFile({
        id: fileId,
        blob: new Blob(["Private sample evidence text"], {
          type: "text/plain",
        }),
      });
      c.attachments.push({
        id: WWModel.uid(),
        name: "Sample evidence.txt",
        kind: "file",
        fileId,
        size: 28,
        createdAt: new Date().toISOString(),
      });
      c.attachments.push({
        id: WWModel.uid(),
        name: "Paper copy",
        kind: "paper",
        value: "Cabinet B / sample folder",
        createdAt: new Date().toISOString(),
      });
      c.attachments.push({
        id: WWModel.uid(),
        name: "Drive reference",
        kind: "drive",
        value: "https://drive.google.com/file/d/fictional/view",
        createdAt: new Date().toISOString(),
      });
      await WWStore.saveCase(c);
      return c.id;
    });
    await a.page.evaluate((input) => sync.connect(input), {
      url: service,
      token,
      passphrase: phrase,
    });
    assert.equal(cloud.version, 1);
    assert.equal(cloud.uploads, 1);
    assert.equal(cloud.metadataWrites[0].snapshot.caseCount, 1);
    assert.equal(cloud.metadataWrites[0].snapshot.taskDueDates.length, 19);
    assert.deepEqual(cloud.metadataWrites[0].snapshot.caseDueDates, [
      "2040-12-31",
    ]);
    assert.ok(
      !JSON.stringify(cloud.metadataWrites[0].snapshot).includes("Fictional"),
    );
    const encryptedJSON = JSON.stringify(cloud.payload);
    for (const value of [
      "Fictional encrypted patient",
      "Private sample case note",
      "Cabinet B",
      "drive.google.com",
      phrase,
      token,
    ])
      assert.ok(!encryptedJSON.includes(value));
    for (const bytes of cloud.files.values())
      assert.ok(!bytes.includes(Buffer.from("Private sample evidence text")));

    await b.page.evaluate((input) => sync.connect(input), {
      url: service,
      token,
      passphrase: phrase,
    });
    const shared = await b.page.evaluate(async (id) => {
      const c = (await WWStore.getCases()).find((c) => c.id === id);
      return {
        name: c.name,
        notes: c.notes.length,
        kinds: c.attachments.map((a) => a.kind),
        text: await (await WWStore.getFile(c.attachments[0].fileId)).text(),
        due: c.tasks[0].dueDate,
      };
    }, id);
    assert.deepEqual(shared, {
      name: "Fictional encrypted patient",
      notes: 1,
      kinds: ["file", "paper", "drive"],
      text: "Private sample evidence text",
      due: "2040-12-03",
    });
    await a.page.evaluate(
      async (id) =>
        sync.withWrite(async () => {
          const c = (await WWStore.getCases()).find((c) => c.id === id);
          c.tasks[0].done = true;
          await WWStore.saveCase(c);
        }),
      id,
    );
    await b.page.evaluate(() => sync.refresh());
    assert.equal(
      await b.page.evaluate(
        async (id) =>
          (await WWStore.getCases()).find((c) => c.id === id).tasks[0].done,
        id,
      ),
      true,
    );
    assert.equal(
      cloud.uploads,
      1,
      "Metadata edits reuse existing encrypted evidence.",
    );

    await a.context.setOffline(true);
    const offline = await a.page.evaluate(async () => {
      let called = false;
      try {
        await sync.withWrite(async () => {
          called = true;
          await WWStore.clearAll();
        });
      } catch (error) {
        return {
          called,
          code: error.code,
          count: (await WWStore.getCases()).length,
        };
      }
    });
    assert.deepEqual(offline, { called: false, code: "OFFLINE", count: 1 });
    await a.context.setOffline(false);

    // A saves a local draft after refreshing, while B wins the next cloud version.
    await a.page.evaluate((id) => {
      window.pendingWrite = sync
        .withWrite(async () => {
          const c = (await WWStore.getCases()).find((c) => c.id === id);
          c.name = "A losing draft";
          await WWStore.saveCase(c);
          window.writeReady = true;
          await new Promise((resolve) => {
            window.resumeWrite = resolve;
          });
        })
        .then(
          () => "saved",
          (error) => error.code,
        );
      return true;
    }, id);
    await a.page.waitForFunction(() => window.writeReady);
    await b.page.evaluate(
      async (id) =>
        sync.withWrite(async () => {
          const c = (await WWStore.getCases()).find((c) => c.id === id);
          c.notes.push({
            id: WWModel.uid(),
            text: "B winning note",
            createdAt: new Date().toISOString(),
          });
          await WWStore.saveCase(c);
        }),
      id,
    );
    const conflict = await a.page.evaluate(async () => {
      resumeWrite();
      return pendingWrite;
    });
    assert.equal(conflict, "CONFLICT");
    assert.equal(await a.page.evaluate(() => sync.isConflicted()), true);
    assert.equal(
      await a.page.evaluate(
        async (id) => (await WWStore.getCases()).find((c) => c.id === id).name,
        id,
      ),
      "Fictional encrypted patient",
      "Losing draft is rolled back locally.",
    );
    const blocked = await a.page.evaluate(async () => {
      let called = false;
      try {
        await sync.withWrite(() => {
          called = true;
        });
      } catch (error) {
        return { called, code: error.code };
      }
    });
    assert.deepEqual(blocked, { called: false, code: "CONFLICT" });
    await a.page.evaluate(() => sync.refresh());
    assert.equal(
      await a.page.evaluate(
        async (id) =>
          (await WWStore.getCases()).find((c) => c.id === id).notes.at(-1).text,
        id,
      ),
      "B winning note",
    );
    assert.equal(await a.page.evaluate(() => sync.isConflicted()), false);

    // Deleting a case/file locally and then failing a CAS must restore its Blob too.
    await a.page.evaluate((id) => {
      window.writeReady = false;
      window.pendingWrite = sync
        .withWrite(async () => {
          await WWStore.deleteCase(id);
          window.writeReady = true;
          await new Promise((resolve) => {
            window.resumeWrite = resolve;
          });
        })
        .then(
          () => "saved",
          (error) => error.code,
        );
      return true;
    }, id);
    await a.page.waitForFunction(() => window.writeReady);
    await b.page.evaluate(async () =>
      sync.withWrite(async () => {
        const settings = await WWStore.getSettings();
        await WWStore.saveSettings({ ...settings, demo: false });
      }),
    );
    assert.equal(
      await a.page.evaluate(async () => {
        resumeWrite();
        return pendingWrite;
      }),
      "CONFLICT",
    );
    assert.equal(
      await a.page.evaluate(async (id) => {
        const c = (await WWStore.getCases()).find((c) => c.id === id);
        return (await WWStore.getFile(c.attachments[0].fileId)).text();
      }, id),
      "Private sample evidence text",
    );
    await a.page.evaluate(() => sync.refresh());

    const c = await device();
    await c.page.evaluate(async () =>
      WWStore.saveCase(WWModel.createCase({ name: "Keep local sample" })),
    );
    const wrong = await c.page.evaluate(
      async (input) => {
        try {
          await sync.connect(input);
        } catch (error) {
          return {
            code: error.code,
            names: (await WWStore.getCases()).map((c) => c.name),
            connected: sync.isConnected(),
          };
        }
      },
      { url: service, token, passphrase: "wrong encryption phrase 999" },
    );
    assert.deepEqual(wrong, {
      code: "DECRYPT",
      names: ["Keep local sample"],
      connected: false,
    });

    await a.page.reload();
    await a.page.evaluate(async () => {
      await WWStore.init();
      window.sync = WWSync.create({ DB: WWStore });
    });
    assert.deepEqual(
      await a.page.evaluate(() => [sync.isConnected(), sync.isUnlocked()]),
      [true, false],
    );
    const locked = await a.page.evaluate(async () => {
      try {
        await sync.withWrite(() => WWStore.clearAll());
      } catch (error) {
        return error.code;
      }
    });
    assert.equal(locked, "LOCKED");
    await a.page.evaluate((passphrase) => sync.unlock(passphrase), phrase);
    const stored = await a.page.evaluate(async () => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
      backup: JSON.stringify(await WWStore.exportBackup()),
    }));
    assert.ok(
      !stored.local.includes(phrase) && !stored.session.includes(phrase),
    );
    assert.ok(
      !stored.backup.includes(token) && !stored.backup.includes(service),
    );

    const google = await device();
    await google.page.evaluate((input) => sync.connect(input), {
      url: service,
      authType: "google",
      clientId: "example.apps.googleusercontent.com",
      token: googleToken,
      passphrase: phrase,
    });
    const googleStored = await google.page.evaluate(() => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
    }));
    assert.ok(!googleStored.local.includes(googleToken));
    assert.ok(googleStored.session.includes(googleToken));
    assert.ok(
      googleStored.local.includes("example.apps.googleusercontent.com"),
    );

    // A new device must reject modified ciphertext and keep its local copy intact.
    const [remoteFileId, original] = cloud.files.entries().next().value;
    const altered = Buffer.from(original);
    altered[altered.length - 1] ^= 1;
    cloud.files.set(remoteFileId, altered);
    const damaged = await device();
    const damagedResult = await damaged.page.evaluate(
      async (input) => {
        try {
          await sync.connect(input);
        } catch (error) {
          return { code: error.code, count: (await WWStore.getCases()).length };
        }
      },
      { url: service, token, passphrase: phrase },
    );
    assert.deepEqual(damagedResult, { code: "DECRYPT", count: 0 });
    cloud.files.set(remoteFileId, original);
    await a.page.evaluate(() => sync.disconnect());
    assert.equal(await a.page.evaluate(() => sync.getConnection()), null);
    assert.equal(
      await a.page.evaluate(async () => (await WWStore.getCases()).length),
      1,
      "Disconnect retains the local cache.",
    );
    assert.deepEqual(errors, []);
  },
);

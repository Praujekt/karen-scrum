import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReminderService,
  loadEnvironment,
  ReminderError,
} from "./reminder-service.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; img-src 'self' data: blob:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cache-Control": "no-store",
};
async function readJson(request) {
  if (
    !request.headers["content-type"]
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ReminderError("Use application/json for this request.", 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024)
      throw new ReminderError("The reminder snapshot is too large.", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ReminderError("The request contains invalid JSON.");
  }
}
export function createWeekwiseServer({
  service = createReminderService(),
  staticDirectory = path.join(root, "dist"),
} = {}) {
  const server = http.createServer(async (request, response) => {
    const headers = { ...securityHeaders };
    function json(status, body) {
      response.writeHead(status, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
    }
    try {
      const address = server.address();
      const expectedHost = `127.0.0.1:${address.port}`,
        expectedOrigin = `http://${expectedHost}`;
      if (request.headers.host !== expectedHost)
        return json(403, { error: `Open Karen's Load at ${expectedOrigin}.` });
      const url = new URL(request.url, expectedOrigin);
      if (url.pathname.startsWith("/api/")) {
        if (request.headers.origin && request.headers.origin !== expectedOrigin)
          return json(403, {
            error: "Requests must come from your local Karen's Load window.",
          });
        if (request.headers["sec-fetch-site"] === "cross-site")
          return json(403, { error: "Cross-site requests are not allowed." });
        if (
          request.method !== "GET" &&
          (request.headers.origin !== expectedOrigin ||
            request.headers["x-weekwise-request"] !== "1")
        )
          return json(403, {
            error: "A same-origin Karen's Load request is required.",
          });
        if (request.method === "GET" && url.pathname === "/api/reminders")
          return json(200, await service.getStatus());
        if (request.method === "PUT" && url.pathname === "/api/reminders")
          return json(200, await service.save(await readJson(request)));
        if (
          request.method === "PUT" &&
          url.pathname === "/api/reminders/snapshot"
        )
          return json(
            200,
            await service.syncSnapshot((await readJson(request)).snapshot),
          );
        if (
          request.method === "POST" &&
          url.pathname === "/api/reminders/test"
        ) {
          await readJson(request);
          return json(200, await service.run({ test: true }));
        }
        return json(404, { error: "Unknown reminder endpoint." });
      }
      if (!["GET", "HEAD"].includes(request.method))
        return json(405, { error: "Method not allowed." });
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return json(400, { error: "Invalid path." });
      }
      if (
        pathname.includes("\0") ||
        pathname.includes("\\") ||
        pathname.split("/").some((part) => part.startsWith("."))
      )
        return json(404, { error: "File not found." });
      const base = await realpath(staticDirectory),
        candidate = path.resolve(
          base,
          "." + (pathname === "/" ? "/index.html" : pathname),
        );
      if (!candidate.startsWith(base + path.sep))
        return json(404, { error: "File not found." });
      let filename;
      try {
        filename = await realpath(candidate);
      } catch (error) {
        if (error.code === "ENOENT")
          return json(404, { error: "File not found." });
        throw error;
      }
      if (
        !filename.startsWith(base + path.sep) ||
        !(await stat(filename)).isFile()
      )
        return json(404, { error: "File not found." });
      const content = await readFile(filename);
      response.writeHead(200, {
        ...headers,
        "Content-Type":
          mime[path.extname(filename)] || "application/octet-stream",
        "Content-Length": content.length,
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (!response.headersSent)
        json(error instanceof ReminderError ? error.status : 500, {
          error:
            error instanceof ReminderError
              ? error.message
              : "The local service could not complete the request.",
        });
      else response.end();
    }
  });
  return server;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  loadEnvironment();
  // Keep an existing custom origin stable while the public setting uses the new name.
  const configuredPort =
    process.env.KARENS_LOAD_PORT || process.env.WEEKWISE_PORT;
  const port = configuredPort ? Number(configuredPort) : 47831;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(
      "KARENS_LOAD_PORT must be a port number between 1024 and 65535.",
    );
  const localUrl = `http://127.0.0.1:${port}`;
  const service = createReminderService();
  const server = createWeekwiseServer({ service });
  const check = () =>
    service.run().catch((error) => {
      if (error.status !== 409) console.error("Reminder check:", error.message);
    });
  const timer = setInterval(check, 60000);
  timer.unref();
  server.on("error", (error) => {
    clearInterval(timer);
    console.error(
      error.code === "EADDRINUSE"
        ? `Cannot start Karen's Load because port ${port} is in use. If Karen's Load is already open, return to its window. Otherwise close the app using that port or set KARENS_LOAD_PORT in .env. Changing the port creates a separate browser storage location.`
        : error.message,
    );
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `Karen's Load is ready: ${localUrl}\nKeep this window open for email/SMS reminders. Press Ctrl+C to stop.`,
    );
    if (process.argv.includes("--open")) {
      const command =
        process.platform === "win32"
          ? "rundll32.exe"
          : process.platform === "darwin"
            ? "open"
            : "xdg-open";
      const args =
        process.platform === "win32"
          ? ["url.dll,FileProtocolHandler", localUrl]
          : [localUrl];
      const browser = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      browser.on("error", () =>
        console.error(`Open ${localUrl} in your browser.`),
      );
      browser.unref();
    }
    check();
  });
  const shutdown = () => {
    clearInterval(timer);
    server.close(() => process.exit());
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

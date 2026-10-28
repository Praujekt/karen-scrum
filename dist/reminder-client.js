(function (root) {
  "use strict";
  const scope = new URL(".", root.location.href).pathname;
  const storageKey = "weekwise-cloud-connection:v1:" + scope;
  let connection = null;
  let storageError = "";
  let workspaceProvider = () => null;
  function sharedConnection() {
    return workspaceProvider();
  }

  function validate(url, token) {
    let parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch (_) {
      throw new Error("Enter the full HTTPS service URL.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        "Use an HTTPS service origin only, without a path, credentials, query, or fragment.",
      );
    }
    const secret = String(token || "").trim();
    if (!/^[\x21-\x7e]{32,512}$/.test(secret)) {
      throw new Error(
        "Enter a connection token of 32–512 characters without spaces.",
      );
    }
    return { url: parsed.origin, token: secret };
  }
  try {
    const saved = root.localStorage.getItem(storageKey);
    if (saved) {
      const parsed = JSON.parse(saved);
      connection = validate(parsed.url, parsed.token);
    }
  } catch (_) {
    storageError =
      "The saved cloud connection could not be read. Reconnect the same service to manage its schedule.";
  }
  function currentTimeZone() {
    return "America/Los_Angeles";
  }
  async function request(path, method, body, candidate) {
    const chosen = candidate || sharedConnection() || connection;
    if (chosen && chosen.locked)
      throw new Error(
        "Unlock the shared workspace before using its reminder service.",
      );
    if (!chosen && storageError) throw new Error(storageError);
    if (!chosen && !canUseLocal())
      throw new Error(
        "Connect a cloud reminder service to schedule reminders from this website.",
      );
    let url = path,
      payload = body;
    const headers = {};
    if (chosen) {
      const endpoints = {
        "/api/reminders": method === "PUT" ? "/config" : "/status",
        "/api/reminders/snapshot": "/snapshot",
        "/api/reminders/test": "/test",
      };
      if (!endpoints[path]) throw new Error("Unknown reminder operation.");
      url = chosen.url + endpoints[path];
      headers.Authorization = "Bearer " + chosen.token;
      if (path === "/api/reminders" && method === "PUT")
        payload = { ...body, timeZone: currentTimeZone() };
    }
    if (payload)
      Object.assign(headers, {
        "Content-Type": "application/json",
        "X-Weekwise-Request": "1",
      });
    let response;
    try {
      response = await root.fetch(url, {
        method: method || "GET",
        headers,
        body: payload ? JSON.stringify(payload) : undefined,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(path.endsWith("/test") ? 55000 : 20000),
      });
    } catch (_) {
      throw new Error(
        chosen
          ? "The cloud reminder service could not be reached. Check its URL, allowed website origin, and connection."
          : "The local reminder service could not be reached.",
      );
    }
    let data;
    try {
      data = await response.json();
    } catch (_) {
      throw new Error("The reminder service returned an invalid response.");
    }
    if (!response.ok)
      throw new Error(
        data.error || "The reminder service could not complete the request.",
      );
    if (
      !path.endsWith("/test") &&
      (!data ||
        !data.config ||
        typeof data.config.enabled !== "boolean" ||
        !Array.isArray(data.config.channels) ||
        typeof data.config.email !== "string" ||
        typeof data.config.phone !== "string" ||
        typeof data.config.time !== "string" ||
        !Number.isInteger(data.config.daysAhead))
    ) {
      throw new Error(
        "This URL did not return a valid Karen's Load reminder service.",
      );
    }
    return data;
  }
  function canUseLocal() {
    return root.location.hostname === "127.0.0.1";
  }
  function checkStorage() {
    const testKey = storageKey + ":check";
    try {
      root.localStorage.setItem(testKey, "1");
      root.localStorage.removeItem(testKey);
    } catch (_) {
      throw new Error(
        "Allow browser storage before connecting the cloud reminder service.",
      );
    }
  }
  function save(value) {
    const clean = validate(value.url, value.token);
    root.localStorage.setItem(storageKey, JSON.stringify(clean));
    connection = clean;
    storageError = "";
  }
  function clear() {
    root.localStorage.removeItem(storageKey);
    connection = null;
    storageError = "";
  }
  root.WWReminderClient = {
    validate,
    request,
    save,
    clear,
    checkStorage,
    canUseLocal,
    currentTimeZone,
    hasCloud: () => Boolean(sharedConnection() || connection || storageError),
    usesWorkspace: () => Boolean(sharedConnection()),
    setWorkspaceProvider: (provider) => {
      workspaceProvider =
        typeof provider === "function" ? provider : () => null;
    },
    connectionUrl: () =>
      sharedConnection()
        ? sharedConnection().url
        : connection
          ? connection.url
          : "Saved cloud connection",
    storageKey,
  };
})(window);

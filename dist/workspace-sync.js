(function (root) {
  "use strict";
  const VERSION = 1;
  const ITERATIONS = 210000;
  const MAX_FILE = 25 * 1024 * 1024;
  const MAX_TOTAL = 100 * 1024 * 1024;
  const MAX_METADATA = 7 * 1024 * 1024;
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const encoder = new TextEncoder();

  function problem(message, code, extra) {
    return Object.assign(new Error(message), { code }, extra || {});
  }
  function base64(bytes) {
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 32768)
      parts.push(
        String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768)),
      );
    return root.btoa(parts.join(""));
  }
  function unbase64(text, length, maximum) {
    if (
      typeof text !== "string" ||
      text.length > Math.ceil(maximum / 3) * 4 ||
      text.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(text)
    )
      throw problem(
        "The shared workspace has an invalid encrypted payload.",
        "INVALID",
      );
    let binary;
    try {
      binary = root.atob(text);
    } catch (_) {
      throw problem(
        "The shared workspace has invalid encrypted data.",
        "INVALID",
      );
    }
    if ((length && binary.length !== length) || binary.length > maximum)
      throw problem(
        "The shared workspace has an invalid encryption header.",
        "INVALID",
      );
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  function validateEnvelope(payload) {
    if (!payload || payload.version !== VERSION)
      throw problem(
        "This shared workspace uses an unsupported encryption format.",
        "INVALID",
      );
    return {
      salt: unbase64(payload.salt, 16, 16),
      iv: unbase64(payload.iv, 12, 12),
      data: unbase64(payload.data, 0, MAX_METADATA + 16),
    };
  }
  function validateConnection(input, requireToken) {
    let url;
    try {
      url = new URL(String(input.url || "").trim());
    } catch (_) {
      throw problem(
        "Enter the full HTTPS workspace service URL.",
        "CONNECTION",
      );
    }
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw problem(
        "Use an HTTPS service origin without a path, query, or embedded credentials.",
        "CONNECTION",
      );
    const authType =
      input.authType === "google"
        ? "google"
        : input.authType === undefined ||
            ["key", "token"].includes(input.authType)
          ? "key"
          : "";
    if (!authType)
      throw problem(
        "Choose a supported workspace sign-in method.",
        "CONNECTION",
      );
    const token = String(input.token || "").trim();
    if (
      (requireToken || token) &&
      (authType === "key"
        ? !/^[\x21-\x7e]{32,512}$/.test(token)
        : token.length < 32 ||
          token.length > 8192 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    )
      throw problem(
        authType === "google"
          ? "Sign in with Google again to connect this workspace."
          : "Enter a workspace connection key of 32 to 512 visible characters.",
        "AUTH",
      );
    const clientId = String(input.clientId || "").trim();
    if (clientId.length > 300)
      throw problem("The Google client ID is too long.", "CONNECTION");
    return { url: url.origin, authType, clientId, token };
  }
  function phraseBytes(passphrase) {
    if (
      typeof passphrase !== "string" ||
      passphrase.length < 12 ||
      passphrase.length > 1024
    )
      throw problem(
        "Use the same encryption passphrase on each device, with at least 12 characters.",
        "PASSPHRASE",
      );
    return encoder.encode(passphrase);
  }
  async function derive(passphrase, salt) {
    if (!root.crypto || !root.crypto.subtle)
      throw problem(
        "Encrypted sync requires a modern browser on HTTPS or localhost.",
        "CRYPTO",
      );
    const bytes = phraseBytes(passphrase);
    try {
      const material = await root.crypto.subtle.importKey(
        "raw",
        bytes,
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      return await root.crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-512", salt, iterations: ITERATIONS },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    } finally {
      bytes.fill(0);
    }
  }
  function aadFile(id, remoteId) {
    return encoder.encode("weekwise:file:v1:" + id + ":" + remoteId);
  }
  const aadMetadata = encoder.encode("weekwise:workspace:v1");

  function create(options) {
    const DB = (options && options.DB) || root.WWStore;
    if (!DB || !DB.exportSync || !DB.importSync)
      throw new Error("Load the Weekwise data store before workspace sync.");
    const scope = new URL(".", root.location.href).pathname;
    const storageKey = "weekwise-workspace-connection:v1:" + scope;
    const sessionKey = storageKey + ":google-session";
    let connection = null,
      key = null,
      salt = null,
      version = null,
      updatedAt = null;
    let fileMap = new Map(),
      conflicted = false,
      lastError = "",
      lastErrorCode = "";
    let queue = Promise.resolve();
    try {
      const saved = JSON.parse(root.localStorage.getItem(storageKey) || "null");
      if (saved)
        connection = validateConnection(
          {
            ...saved,
            token:
              saved.authType === "google"
                ? root.sessionStorage.getItem(sessionKey) || ""
                : saved.token,
          },
          false,
        );
    } catch (_) {
      lastError =
        "The saved workspace connection could not be read. Connect again in settings.";
    }

    function getConnection() {
      return connection ? { ...connection } : null;
    }
    function getState() {
      return {
        connected: !!connection,
        unlocked: !!key,
        conflicted,
        version,
        updatedAt,
        lastError,
        lastErrorCode,
      };
    }
    function changed() {
      if (root.dispatchEvent && root.CustomEvent)
        root.dispatchEvent(
          new CustomEvent("weekwise-sync-change", { detail: getState() }),
        );
    }
    function serial(work) {
      const task = queue.catch(() => {}).then(work);
      queue = task.catch(() => {});
      return task.catch((error) => {
        lastError = error.message;
        lastErrorCode = error.code || "";
        changed();
        throw error;
      });
    }
    function persist() {
      try {
        const saved = {
          url: connection.url,
          authType: connection.authType,
          clientId: connection.clientId,
        };
        if (connection.authType === "key") saved.token = connection.token;
        root.localStorage.setItem(storageKey, JSON.stringify(saved));
        if (connection.authType === "google")
          root.sessionStorage.setItem(sessionKey, connection.token);
        else root.sessionStorage.removeItem(sessionKey);
      } catch (_) {
        throw problem(
          "This browser could not save the workspace connection. Check browser storage settings.",
          "STORAGE",
        );
      }
    }
    function clearError() {
      lastError = "";
      lastErrorCode = "";
      changed();
    }
    function assertReady() {
      if (!connection) return;
      if (!key)
        throw problem(
          "Unlock the shared workspace with its encryption passphrase before editing.",
          "LOCKED",
        );
      if (!connection.token)
        throw problem("Sign in again to connect this workspace.", "AUTH");
      if (root.navigator.onLine === false)
        throw problem(
          "The shared workspace is offline. You can read this cached copy; reconnect before making changes.",
          "OFFLINE",
        );
    }
    async function request(path, method, body, binary) {
      if (root.navigator.onLine === false)
        throw problem(
          "The shared workspace is offline. Reconnect before making changes.",
          "OFFLINE",
        );
      if (!connection || !connection.token)
        throw problem("Sign in again to connect this workspace.", "AUTH");
      const headers = {
        Authorization: "Bearer " + connection.token,
        "X-Weekwise-Request": "1",
      };
      if (body !== undefined)
        headers["Content-Type"] = binary
          ? "application/octet-stream"
          : "application/json";
      let response;
      try {
        response = await root.fetch(connection.url + path, {
          method: method || "GET",
          headers,
          body:
            body === undefined
              ? undefined
              : binary
                ? body
                : JSON.stringify(body),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(120000),
        });
      } catch (_) {
        throw problem(
          "Could not confirm the shared workspace request. The previous cached copy was kept; reconnect and refresh before editing.",
          "OFFLINE",
        );
      }
      if (!response.ok) {
        let error = {};
        try {
          error = await response.json();
        } catch (_) {}
        if (response.status === 409)
          throw problem(
            "Another device changed this workspace. Your attempted change was not saved. Refresh the shared workspace and try again.",
            "CONFLICT",
            { currentVersion: error.version },
          );
        if (response.status === 401 || response.status === 403)
          throw problem(
            "Workspace sign-in expired or was rejected. Sign in again, then refresh.",
            "AUTH",
          );
        throw problem(
          typeof error.error === "string"
            ? error.error
            : "The shared workspace could not complete the request.",
          "SERVER",
        );
      }
      return response;
    }
    async function remote() {
      const response = await request("/workspace");
      const text = await response.text();
      if (text.length > 11 * 1024 * 1024)
        throw problem(
          "The shared workspace metadata exceeds the supported limit.",
          "INVALID",
        );
      let result;
      try {
        result = JSON.parse(text);
      } catch (_) {
        throw problem(
          "The workspace service returned an invalid response.",
          "INVALID",
        );
      }
      if (
        !result ||
        !Number.isSafeInteger(result.version) ||
        result.version < 0 ||
        !(result.payload === null || typeof result.payload === "object")
      )
        throw problem(
          "The workspace service returned an invalid version.",
          "INVALID",
        );
      if (result.payload === null && result.version !== 0)
        throw problem(
          "The shared workspace metadata is missing. Your cached copy was kept.",
          "INVALID",
        );
      return result;
    }
    function validateMetadata(metadata) {
      if (
        !metadata ||
        metadata.format !== "weekwise-sync" ||
        metadata.version !== VERSION ||
        !Array.isArray(metadata.files) ||
        metadata.files.length > 10000
      )
        throw problem(
          "The decrypted workspace has an unsupported format.",
          "INVALID",
        );
      let total = 0;
      const remoteIds = new Set();
      for (const file of metadata.files) {
        if (
          !file ||
          typeof file.id !== "string" ||
          !UUID.test(file.remoteId) ||
          remoteIds.has(file.remoteId) ||
          typeof file.type !== "string" ||
          file.type.length > 200 ||
          !Number.isInteger(file.size) ||
          file.size < 0 ||
          file.size > MAX_FILE
        )
          throw problem(
            "The shared workspace has an invalid evidence entry.",
            "INVALID",
          );
        total += file.size;
        remoteIds.add(file.remoteId);
        if (total > MAX_TOTAL)
          throw problem(
            "Shared evidence exceeds the 100 MB workspace limit.",
            "INVALID",
          );
      }
      // Validate all patient metadata and evidence references before downloading.
      DB.validateSync({
        cases: metadata.cases,
        settings: metadata.settings,
        files: metadata.files.map((file) => ({
          id: file.id,
          blob: new Blob(),
        })),
      });
    }
    async function applyRemote(result, selectedKey) {
      const envelope = validateEnvelope(result.payload);
      let bytes;
      try {
        bytes = await root.crypto.subtle.decrypt(
          { name: "AES-GCM", iv: envelope.iv, additionalData: aadMetadata },
          selectedKey,
          envelope.data,
        );
      } catch (_) {
        throw problem(
          "The encryption passphrase did not unlock this workspace, or its encrypted data was damaged. Your cached records were kept.",
          "DECRYPT",
        );
      }
      if (bytes.byteLength > MAX_METADATA)
        throw problem("Shared workspace metadata is too large.", "INVALID");
      let metadata;
      try {
        metadata = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch (_) {
        throw problem("The decrypted workspace is not valid data.", "INVALID");
      }
      validateMetadata(metadata);
      const local = await DB.exportSync(),
        localFiles = new Map(local.files.map((file) => [file.id, file]));
      const nextFiles = [],
        nextMap = new Map();
      for (const entry of metadata.files) {
        let blob;
        const cached = localFiles.get(entry.id);
        if (
          cached &&
          cached.revision === entry.remoteId &&
          cached.blob.size === entry.size &&
          cached.blob.type === entry.type
        )
          blob = cached.blob;
        else {
          const response = await request("/files/" + entry.remoteId);
          const encrypted = new Uint8Array(await response.arrayBuffer());
          if (encrypted.byteLength !== entry.size + 28)
            throw problem(
              "An encrypted evidence file has the wrong size. Your cached workspace was kept.",
              "INVALID",
            );
          let plain;
          try {
            plain = await root.crypto.subtle.decrypt(
              {
                name: "AES-GCM",
                iv: encrypted.subarray(0, 12),
                additionalData: aadFile(entry.id, entry.remoteId),
              },
              selectedKey,
              encrypted.subarray(12),
            );
          } catch (_) {
            throw problem(
              "An evidence file could not be decrypted. Your cached workspace was kept.",
              "DECRYPT",
            );
          }
          blob = new Blob([plain], { type: entry.type });
        }
        nextFiles.push({ id: entry.id, blob, revision: entry.remoteId });
        nextMap.set(entry.id, { ...entry, revision: entry.remoteId });
      }
      await DB.importSync({
        cases: metadata.cases,
        settings: metadata.settings,
        files: nextFiles,
      });
      key = selectedKey;
      salt = envelope.salt;
      version = result.version;
      updatedAt = result.updatedAt || null;
      fileMap = nextMap;
      conflicted = false;
      clearError();
      return getState();
    }
    async function refreshInternal(force) {
      if (!connection) return getState();
      assertReady();
      const result = await remote();
      if (result.payload === null)
        throw problem(
          "The cloud workspace is empty. Reconnect explicitly before uploading this cached workspace.",
          "EMPTY",
        );
      if (version !== null && result.version < version)
        throw problem(
          "The service returned an older workspace version. Your newer cached copy was kept.",
          "INVALID",
        );
      const envelope = validateEnvelope(result.payload);
      if (!salt || base64(salt) !== base64(envelope.salt)) {
        key = null;
        throw problem(
          "The shared encryption key changed. Unlock this workspace again before continuing.",
          "LOCKED",
        );
      }
      if (!force && result.version === version) {
        conflicted = false;
        clearError();
        return getState();
      }
      return applyRemote(result, key);
    }
    async function pushInternal() {
      if (!connection) return getState();
      assertReady();
      if (conflicted)
        throw problem(
          "Refresh the shared workspace before saving another change.",
          "CONFLICT",
        );
      if (!Number.isSafeInteger(version) || !salt)
        throw problem(
          "Unlock and refresh the shared workspace before saving.",
          "LOCKED",
        );
      const snapshot = await DB.exportSync();
      DB.validateSync(snapshot);
      const activeCases = snapshot.cases.filter(
        (record) => record.status !== "completed" && !record.demo,
      );
      // Counts and dates accompany the encrypted metadata so the Worker can
      // commit the reminder snapshot against the same accepted workspace version.
      // No names, notes, titles, or evidence locations are included here.
      const reminderSnapshot = {
        caseCount: activeCases.length,
        caseDueDates: activeCases.map((record) => record.dueDate),
        taskDueDates: activeCases.flatMap((record) =>
          record.tasks.filter((task) => !task.done).map((task) => task.dueDate),
        ),
      };
      const attached = new Set(
        snapshot.cases.flatMap((record) =>
          record.attachments
            .filter((a) => a.kind === "file")
            .map((a) => a.fileId),
        ),
      );
      const activeFiles = snapshot.files.filter((file) =>
        attached.has(file.id),
      );
      const entries = [],
        nextMap = new Map(),
        normalizedFiles = [];
      for (const file of activeFiles) {
        let entry = fileMap.get(file.id);
        if (
          !entry ||
          entry.revision !== file.revision ||
          entry.size !== file.blob.size ||
          entry.type !== file.blob.type
        ) {
          const remoteId = root.crypto.randomUUID(),
            iv = root.crypto.getRandomValues(new Uint8Array(12));
          const encrypted = await root.crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: aadFile(file.id, remoteId) },
            key,
            await file.blob.arrayBuffer(),
          );
          await request(
            "/files/" + remoteId,
            "PUT",
            new Blob([iv, encrypted], { type: "application/octet-stream" }),
            true,
          );
          entry = {
            id: file.id,
            remoteId,
            type: file.blob.type,
            size: file.blob.size,
          };
        }
        entries.push({
          id: entry.id,
          remoteId: entry.remoteId,
          type: entry.type,
          size: entry.size,
        });
        nextMap.set(file.id, { ...entry, revision: entry.remoteId });
        normalizedFiles.push({
          id: file.id,
          blob: file.blob,
          revision: entry.remoteId,
        });
      }
      const plain = encoder.encode(
        JSON.stringify({
          format: "weekwise-sync",
          version: VERSION,
          cases: snapshot.cases,
          settings: snapshot.settings,
          files: entries,
        }),
      );
      if (plain.byteLength > MAX_METADATA)
        throw problem(
          "Workspace notes and metadata exceed the 7 MB shared-workspace limit. Remove unneeded text before syncing.",
          "LIMIT",
        );
      const iv = root.crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await root.crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aadMetadata },
        key,
        plain,
      );
      let result;
      try {
        const response = await request("/workspace", "PUT", {
          expectedVersion: version,
          payload: {
            version: VERSION,
            salt: base64(salt),
            iv: base64(iv),
            data: base64(new Uint8Array(encrypted)),
          },
          snapshot: reminderSnapshot,
        });
        result = await response.json();
        if (!result || result.version !== version + 1)
          throw problem(
            "The server did not confirm the saved workspace version. Refresh before editing.",
            "INVALID",
          );
      } catch (error) {
        conflicted = true;
        throw error;
      }
      // Normalize local file revisions to their immutable remote identities so a
      // reload can reuse cached files instead of downloading every attachment.
      await DB.importSync({
        cases: snapshot.cases,
        settings: snapshot.settings,
        files: normalizedFiles,
      });
      version = result.version;
      updatedAt = result.updatedAt || null;
      fileMap = nextMap;
      conflicted = false;
      clearError();
      return getState();
    }
    async function connect(input) {
      return serial(async () => {
        const candidate = validateConnection(input || {}, true);
        phraseBytes(input.passphrase).fill(0);
        const old = {
          connection,
          key,
          salt,
          version,
          updatedAt,
          fileMap,
          conflicted,
        };
        const local = await DB.exportSync();
        connection = candidate;
        key = null;
        salt = null;
        version = null;
        fileMap = new Map();
        conflicted = false;
        try {
          const result = await remote();
          if (result.payload) {
            const envelope = validateEnvelope(result.payload);
            await applyRemote(
              result,
              await derive(input.passphrase, envelope.salt),
            );
          } else {
            salt = root.crypto.getRandomValues(new Uint8Array(16));
            key = await derive(input.passphrase, salt);
            version = 0;
            await pushInternal();
          }
          persist();
          clearError();
          return getState();
        } catch (error) {
          await DB.importSync(local);
          ({ connection, key, salt, version, updatedAt, fileMap, conflicted } =
            old);
          throw error;
        }
      });
    }
    async function unlock(passphrase, token) {
      return serial(async () => {
        if (!connection)
          throw problem("Connect a shared workspace first.", "CONNECTION");
        if (token !== undefined) {
          connection = validateConnection({ ...connection, token }, true);
          persist();
        }
        const result = await remote();
        if (!result.payload)
          throw problem(
            "The cloud workspace is empty. Reconnect explicitly to initialize it.",
            "EMPTY",
          );
        const envelope = validateEnvelope(result.payload);
        return applyRemote(result, await derive(passphrase, envelope.salt));
      });
    }
    function withWrite(work) {
      return serial(async () => {
        if (typeof work !== "function")
          throw new TypeError("A write callback is required.");
        if (!connection) return work();
        if (conflicted)
          throw problem(
            "Refresh the shared workspace before saving another change.",
            "CONFLICT",
          );
        await refreshInternal(false);
        const before = await DB.exportSync();
        let pushing = false;
        try {
          const result = await work();
          pushing = true;
          await pushInternal();
          return result;
        } catch (error) {
          try {
            await DB.importSync(before);
          } catch (_) {
            conflicted = true;
            throw problem(
              "The save failed and the local copy could not be restored. Keep this tab open and download a backup before continuing.",
              "ROLLBACK_FAILED",
            );
          }
          if (pushing) conflicted = true;
          throw error;
        }
      });
    }
    function refresh() {
      return serial(() => refreshInternal(!!conflicted));
    }
    function push() {
      return serial(pushInternal);
    }
    function setToken(token) {
      return serial(async () => {
        if (!connection)
          throw problem("Connect a shared workspace first.", "CONNECTION");
        connection = validateConnection({ ...connection, token }, true);
        persist();
        clearError();
        return getState();
      });
    }
    function disconnect() {
      return serial(async () => {
        try {
          root.localStorage.removeItem(storageKey);
          root.sessionStorage.removeItem(sessionKey);
        } catch (_) {
          throw problem(
            "This browser could not remove the saved connection.",
            "STORAGE",
          );
        }
        connection = null;
        key = null;
        salt = null;
        version = null;
        updatedAt = null;
        fileMap = new Map();
        conflicted = false;
        clearError();
        return getState();
      });
    }
    function lock() {
      return serial(async () => {
        key = null;
        salt = null;
        fileMap = new Map();
        changed();
        return getState();
      });
    }
    return {
      getConnection,
      getState,
      isConnected: () => !!connection,
      isUnlocked: () => !!key,
      isConflicted: () => conflicted,
      connect,
      unlock,
      refresh,
      push,
      withWrite,
      setToken,
      disconnect,
      lock,
    };
  }
  root.WWSync = { create };
})(typeof window !== "undefined" ? window : globalThis);

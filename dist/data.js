(function (root) {
  "use strict";

  // Keep the original root/local database while separating project-path copies
  // such as GitHub Pages repositories. Paths are namespacing, not a security boundary.
  const basePath = root.location
    ? new URL(".", root.location.href).pathname.replace(/\/+$/, "")
    : "";
  const DB_NAME = "weekwise-local" + (basePath ? ":" + basePath : "");
  const MAX_FILE = 25 * 1024 * 1024;
  const MAX_BACKUP = 100 * 1024 * 1024;
  let database = null;
  let opening = null;

  function fail(message) {
    throw new Error(message);
  }
  function plain(value) {
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null)
    );
  }
  function string(value, maximum, field, empty) {
    if (
      typeof value !== "string" ||
      value.length > maximum ||
      (!empty && !value.trim())
    )
      fail("Invalid " + field + " in backup.");
    return value;
  }
  function date(value, field) {
    string(value, 10, field);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      fail("Invalid " + field + " in backup.");
    const d = new Date(value + "T00:00:00Z");
    if (
      !Number.isFinite(d.getTime()) ||
      d.toISOString().slice(0, 10) !== value ||
      Number(value.slice(0, 4)) < 1900
    )
      fail("Invalid " + field + " in backup.");
  }
  function stamp(value, field) {
    string(value, 40, field);
    if (
      !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      fail("Invalid " + field + " in backup.");
  }
  function id(value) {
    string(value, 200, "identifier");
  }
  function array(value, maximum, field) {
    if (!Array.isArray(value) || value.length > maximum)
      fail("Invalid " + field + " in backup.");
  }
  function unique(items, field) {
    const seen = new Set();
    for (const item of items) {
      id(item.id);
      if (seen.has(item.id))
        fail("Duplicate " + field + " identifier in backup.");
      seen.add(item.id);
    }
  }
  function jsonSafety(value, depth) {
    if (depth > 20) fail("Backup settings are too deeply nested.");
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return;
    if (Array.isArray(value)) {
      if (value.length > 10000) fail("Backup list is too large.");
      value.forEach((item) => jsonSafety(item, depth + 1));
      return;
    }
    if (!plain(value)) fail("Backup contains unsupported data.");
    for (const key of Object.keys(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        fail("Backup contains an unsupported property.");
      jsonSafety(value[key], depth + 1);
    }
  }
  function validateTemplate(tasks) {
    array(tasks, 1000, "template");
    unique(tasks, "template activity");
    for (const task of tasks) {
      if (!plain(task)) fail("Invalid template activity in backup.");
      string(task.title, 500, "activity title");
      if (
        !Number.isInteger(task.week) ||
        task.week < 1 ||
        task.week > 5 ||
        typeof task.optional !== "boolean"
      )
        fail("Invalid template activity week or optional flag in backup.");
    }
  }
  function validateSettings(settings) {
    if (!plain(settings)) fail("Invalid settings in backup.");
    jsonSafety(settings, 0);
    if (JSON.stringify(settings).length > 1024 * 1024)
      fail("Backup settings are too large.");
    if ("template" in settings) validateTemplate(settings.template);
    if ("templates" in settings) {
      array(settings.templates, 100, "template library");
      if (!settings.templates.length)
        fail("Keep at least one template in the library.");
      unique(settings.templates, "template");
      const names = new Set();
      for (const entry of settings.templates) {
        if (!plain(entry)) fail("Invalid template in backup.");
        string(entry.name, 100, "template name");
        const normalizedName = entry.name.trim().toLowerCase();
        if (names.has(normalizedName)) fail("Template names must be unique.");
        names.add(normalizedName);
        validateTemplate(entry.activities);
        stamp(entry.createdAt, "template creation date");
        stamp(entry.updatedAt, "template update date");
      }
      if (
        "defaultTemplateId" in settings &&
        !settings.templates.some(
          (entry) => entry.id === settings.defaultTemplateId,
        )
      )
        fail("The default template must exist in the library.");
    } else if ("defaultTemplateId" in settings) {
      fail("A default template requires a template library.");
    }
    if ("demo" in settings && typeof settings.demo !== "boolean")
      fail("Invalid demo setting in backup.");
  }
  function validateCase(record) {
    if (!plain(record)) fail("Invalid case in backup.");
    jsonSafety(record, 0);
    id(record.id);
    string(record.name, 200, "patient name");
    if ("sourceTemplateId" in record) id(record.sourceTemplateId);
    if ("sourceTemplateName" in record)
      string(record.sourceTemplateName, 100, "source template name");
    date(record.startDate, "case start date");
    date(record.dueDate, "case due date");
    if (record.dueDate < record.startDate)
      fail("A case due date is before its start date.");
    if (!["open", "in_progress", "completed"].includes(record.status))
      fail("Invalid case status in backup.");
    if ("demo" in record && typeof record.demo !== "boolean")
      fail("Invalid example-case marker in backup.");
    stamp(record.createdAt, "case creation date");
    stamp(record.updatedAt, "case update date");
    array(record.tasks, 1000, "case activities");
    unique(record.tasks, "activity");
    for (const task of record.tasks) {
      if (!plain(task)) fail("Invalid activity in backup.");
      string(task.title, 500, "activity title");
      date(task.dueDate, "activity due date");
      if (
        !Number.isInteger(task.week) ||
        task.week < 1 ||
        task.week > 5 ||
        typeof task.optional !== "boolean" ||
        typeof task.done !== "boolean"
      )
        fail("Invalid activity in backup.");
    }
    array(record.notes, 10000, "notes");
    unique(record.notes, "note");
    for (const note of record.notes) {
      if (!plain(note)) fail("Invalid note in backup.");
      string(note.text, 50000, "note");
      stamp(note.createdAt, "note creation date");
    }
    array(record.attachments, 10000, "attachments");
    unique(record.attachments, "attachment");
    for (const attachment of record.attachments) {
      if (!plain(attachment)) fail("Invalid attachment in backup.");
      string(attachment.name, 500, "attachment name");
      stamp(attachment.createdAt, "attachment creation date");
      if (attachment.kind === "file") {
        id(attachment.fileId);
        if (
          "size" in attachment &&
          (!Number.isInteger(attachment.size) ||
            attachment.size < 0 ||
            attachment.size > MAX_FILE)
        )
          fail("Invalid attachment size in backup.");
      } else if (attachment.kind === "link" || attachment.kind === "drive") {
        string(attachment.value, 4000, "attachment link");
        let url;
        try {
          url = new URL(attachment.value);
        } catch (_) {
          fail("Invalid attachment link in backup.");
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          fail("Only http and https attachment links are supported.");
        if (
          attachment.kind === "drive" &&
          (url.protocol !== "https:" ||
            !["docs.google.com", "drive.google.com"].includes(url.hostname))
        )
          fail(
            "Use a Google Drive or Google Docs HTTPS link for Drive evidence.",
          );
      } else if (attachment.kind === "path") {
        string(attachment.value, 4000, "local file path");
      } else if (attachment.kind === "paper") {
        string(attachment.value, 4000, "paper document location");
      } else fail("Unknown attachment type in backup.");
    }
    if (JSON.stringify(record).length > 5 * 1024 * 1024)
      fail("A case in the backup is too large.");
  }

  function validateBackup(backup) {
    if (!plain(backup) || backup.format !== "weekwise" || backup.version !== 1)
      fail("Choose a Karen's Load version 1 backup file.");
    array(backup.cases, 5000, "cases");
    unique(backup.cases, "case");
    backup.cases.forEach(validateCase);
    validateSettings(backup.settings);
    array(backup.files, 10000, "files");
    unique(backup.files, "file");
    const files = new Set();
    let totalBytes = 0;
    for (const file of backup.files) {
      if (!plain(file)) fail("Invalid evidence file in backup.");
      string(file.type, 200, "file type", true);
      if (file.name !== undefined) string(file.name, 500, "file name", true);
      if (
        typeof file.data !== "string" ||
        file.data.length > Math.ceil(MAX_FILE / 3) * 4 ||
        file.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
      )
        fail("Invalid or oversized evidence file in backup.");
      const bytes =
        (file.data.length / 4) * 3 -
        (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0);
      if (bytes > MAX_FILE) fail("An evidence file exceeds 25 MB.");
      totalBytes += bytes;
      if (totalBytes > MAX_BACKUP)
        fail("Evidence files in a backup must total 100 MB or less.");
      files.add(file.id);
    }
    const usedFiles = new Set();
    for (const record of backup.cases)
      for (const attachment of record.attachments) {
        if (attachment.kind === "file") {
          if (!files.has(attachment.fileId))
            fail("The backup is missing an attached evidence file.");
          if (usedFiles.has(attachment.fileId))
            fail(
              "An uploaded evidence file is attached more than once in the backup.",
            );
          usedFiles.add(attachment.fileId);
        }
      }
    if (JSON.stringify(backup).length > Math.ceil(MAX_BACKUP * 1.4))
      fail("Backup exceeds the 140 MB restore limit.");
    return true;
  }

  function init() {
    if (database) return Promise.resolve();
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!root.indexedDB) {
        reject(
          new Error(
            "This browser cannot save local records. Open Karen's Load in an up-to-date browser.",
          ),
        );
        return;
      }
      let request;
      try {
        request = root.indexedDB.open(DB_NAME, 1);
      } catch (_) {
        reject(
          new Error(
            "Local storage is unavailable. Check browser privacy and storage settings.",
          ),
        );
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("cases"))
          db.createObjectStore("cases", { keyPath: "id" });
        if (!db.objectStoreNames.contains("settings"))
          db.createObjectStore("settings", { keyPath: "id" });
        if (!db.objectStoreNames.contains("files"))
          db.createObjectStore("files", { keyPath: "id" });
      };
      request.onerror = () =>
        reject(
          request.error || new Error("Local storage could not be opened."),
        );
      request.onblocked = () =>
        reject(new Error("Close other Karen's Load tabs, then try again."));
      request.onsuccess = () => {
        database = request.result;
        database.onversionchange = () => {
          database.close();
          database = null;
          opening = null;
        };
        resolve();
      };
    }).catch((error) => {
      opening = null;
      throw error;
    });
    return opening;
  }

  async function transaction(stores, mode, work) {
    await init();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(stores, mode);
      let result, workError;
      tx.oncomplete = () =>
        resolve(typeof result === "function" ? result() : result);
      tx.onerror = () =>
        reject(
          workError ||
            tx.error ||
            new Error("The local save failed. Your changes were not saved."),
        );
      tx.onabort = () =>
        reject(
          workError ||
            tx.error ||
            new Error(
              "The local save was interrupted. Your changes were not saved.",
            ),
        );
      const abort = (error) => {
        workError = error;
        tx.abort();
      };
      try {
        result = work(tx, abort);
      } catch (error) {
        try {
          tx.abort();
        } catch (_) {}
        reject(error);
      }
    });
  }

  async function getCases() {
    return transaction(["cases"], "readonly", (tx) => {
      const request = tx.objectStore("cases").getAll();
      return () => request.result || [];
    });
  }
  async function saveCase(record) {
    validateCase(record);
    return transaction(["cases"], "readwrite", (tx) => {
      tx.objectStore("cases").put(record);
    });
  }
  async function deleteCase(caseId) {
    id(caseId);
    return transaction(["cases", "files"], "readwrite", (tx) => {
      const cases = tx.objectStore("cases");
      const request = cases.get(caseId);
      request.onsuccess = () => {
        if (request.result)
          for (const attachment of request.result.attachments) {
            if (attachment.kind === "file")
              tx.objectStore("files").delete(attachment.fileId);
          }
        cases.delete(caseId);
      };
    });
  }
  async function getSettings() {
    return transaction(["settings"], "readonly", (tx) => {
      const request = tx.objectStore("settings").get("preferences");
      return () => (request.result ? request.result.value : {});
    });
  }
  async function saveSettings(settings) {
    validateSettings(settings);
    return transaction(["settings"], "readwrite", (tx) => {
      tx.objectStore("settings").put({ id: "preferences", value: settings });
    });
  }
  async function putFile(input) {
    if (!input) fail("Choose an evidence file.");
    id(input.id);
    if (!(input.blob instanceof Blob) || input.blob.size > MAX_FILE)
      fail("Choose an evidence file of 25 MB or less.");
    // The size check and put share one readwrite transaction. IndexedDB serializes
    // concurrent uploads against this store, so two tabs cannot bypass the budget.
    return transaction(["files"], "readwrite", (tx, abort) => {
      const store = tx.objectStore("files");
      const cursorRequest = store.openCursor();
      let totalBytes = input.blob.size;
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          // A replacement counts the new blob instead of both old and new copies.
          if (cursor.key !== input.id) totalBytes += cursor.value.blob.size;
          if (totalBytes > MAX_BACKUP) {
            abort(
              new Error(
                "Uploaded evidence would exceed the 100 MB workspace limit. Remove unneeded copies before adding this file.",
              ),
            );
            return;
          }
          cursor.continue();
        } else
          store.put({
            id: input.id,
            blob: input.blob,
            revision: fileRevision(),
          });
      };
    });
  }
  async function getFile(fileId) {
    id(fileId);
    return transaction(["files"], "readonly", (tx) => {
      const request = tx.objectStore("files").get(fileId);
      return () => (request.result ? request.result.blob : null);
    });
  }
  async function deleteFile(fileId) {
    id(fileId);
    return transaction(["files"], "readwrite", (tx) => {
      tx.objectStore("files").delete(fileId);
    });
  }

  function fileRevision() {
    return root.crypto && root.crypto.randomUUID
      ? root.crypto.randomUUID()
      : "revision-" +
          Date.now().toString(36) +
          "-" +
          Math.random().toString(36).slice(2);
  }

  // Sync snapshots retain immutable Blob references. No base64 expansion or file
  // copying is needed for an ordinary case edit or a failed-write rollback.
  async function exportSync() {
    return transaction(["cases", "settings", "files"], "readonly", (tx) => {
      const cases = tx.objectStore("cases").getAll();
      const settings = tx.objectStore("settings").get("preferences");
      const files = tx.objectStore("files").getAll();
      return () => ({
        cases: cases.result || [],
        settings: settings.result ? settings.result.value : {},
        files: (files.result || []).map((file) => ({
          id: file.id,
          blob: file.blob,
          revision: file.revision || file.id,
        })),
      });
    });
  }

  function validateSync(snapshot) {
    if (!plain(snapshot)) fail("Invalid workspace snapshot.");
    array(snapshot.cases, 5000, "cases");
    unique(snapshot.cases, "case");
    snapshot.cases.forEach(validateCase);
    validateSettings(snapshot.settings);
    array(snapshot.files, 10000, "files");
    unique(snapshot.files, "file");
    const files = new Set();
    let total = 0;
    for (const file of snapshot.files) {
      if (
        !plain(file) ||
        !(file.blob instanceof Blob) ||
        file.blob.size > MAX_FILE
      )
        fail("Invalid or oversized evidence in workspace snapshot.");
      if (file.revision !== undefined) id(file.revision);
      total += file.blob.size;
      if (total > MAX_BACKUP)
        fail("Uploaded evidence exceeds the 100 MB workspace limit.");
      files.add(file.id);
    }
    const attached = new Set();
    for (const record of snapshot.cases)
      for (const attachment of record.attachments)
        if (attachment.kind === "file") {
          if (!files.has(attachment.fileId))
            fail("The workspace is missing an attached evidence file.");
          if (attached.has(attachment.fileId))
            fail("An uploaded evidence file is attached more than once.");
          attached.add(attachment.fileId);
        }
    return true;
  }

  async function importSync(snapshot) {
    validateSync(snapshot);
    const cases = structuredClone(snapshot.cases),
      settings = structuredClone(snapshot.settings);
    const files = snapshot.files.map((file) => ({
      id: file.id,
      blob: file.blob,
      revision: file.revision || fileRevision(),
    }));
    return transaction(["cases", "settings", "files"], "readwrite", (tx) => {
      for (const name of ["cases", "settings", "files"])
        tx.objectStore(name).clear();
      for (const record of cases) tx.objectStore("cases").put(record);
      tx.objectStore("settings").put({ id: "preferences", value: settings });
      for (const file of files) tx.objectStore("files").put(file);
    });
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 32768)
      chunks.push(
        String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768)),
      );
    return root.btoa(chunks.join(""));
  }
  function base64ToBlob(encoded, type) {
    const binary = root.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type });
  }

  async function exportBackup() {
    const snapshot = await transaction(
      ["cases", "settings", "files"],
      "readonly",
      (tx) => {
        const cases = tx.objectStore("cases").getAll();
        const settings = tx.objectStore("settings").get("preferences");
        const files = tx.objectStore("files").getAll();
        return () => ({
          cases: cases.result || [],
          settings: settings.result ? settings.result.value : {},
          files: files.result || [],
        });
      },
    );
    const total = snapshot.files.reduce((sum, file) => sum + file.blob.size, 0);
    if (total > MAX_BACKUP)
      fail(
        "Evidence files exceed the 100 MB backup limit. Remove unneeded files before exporting.",
      );
    const files = [];
    for (const file of snapshot.files)
      files.push({
        id: file.id,
        type: file.blob.type || "",
        data: await blobToBase64(file.blob),
      });
    const backup = {
      format: "weekwise",
      version: 1,
      exportedAt: new Date().toISOString(),
      cases: snapshot.cases,
      settings: snapshot.settings,
      files,
    };
    validateBackup(backup);
    return backup;
  }
  async function importBackup(backup) {
    validateBackup(backup);
    const cases = structuredClone(backup.cases);
    const settings = structuredClone(backup.settings);
    const files = backup.files.map((file) => ({
      id: file.id,
      blob: base64ToBlob(file.data, file.type),
      revision: fileRevision(),
    }));
    await transaction(["cases", "settings", "files"], "readwrite", (tx) => {
      for (const name of ["cases", "settings", "files"])
        tx.objectStore(name).clear();
      for (const record of cases) tx.objectStore("cases").put(record);
      tx.objectStore("settings").put({ id: "preferences", value: settings });
      for (const file of files) tx.objectStore("files").put(file);
    });
  }
  async function clearAll() {
    return transaction(["cases", "settings", "files"], "readwrite", (tx) => {
      for (const name of ["cases", "settings", "files"])
        tx.objectStore(name).clear();
    });
  }

  const api = {
    init,
    getCases,
    saveCase,
    deleteCase,
    getSettings,
    saveSettings,
    putFile,
    getFile,
    deleteFile,
    exportBackup,
    importBackup,
    clearAll,
    validateBackup,
    exportSync,
    importSync,
    validateSync,
  };
  root.WWStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

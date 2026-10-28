const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../dist/model.js");
const store = require("../dist/data.js");

function backup() {
  return {
    format: "weekwise",
    version: 1,
    cases: [
      model.createCase({ name: "Fictional Patient", startDate: "2026-10-01" }),
    ],
    settings: { template: model.template(), demo: false },
    files: [],
  };
}

test("valid portable backup contains the complete case and template", () => {
  assert.equal(store.validateBackup(backup()), true);
});

test("broken dates, status values, duplicate IDs, and missing attachment blobs are rejected", () => {
  let value = backup();
  value.cases[0].dueDate = "2026-02-30";
  assert.throws(() => store.validateBackup(value), /due date/);
  value = backup();
  value.cases[0].status = "archived";
  assert.throws(() => store.validateBackup(value), /status/);
  value = backup();
  value.cases.push(structuredClone(value.cases[0]));
  assert.throws(() => store.validateBackup(value), /Duplicate case/);
  value = backup();
  value.cases[0].attachments.push({
    id: "a1",
    name: "Evidence.pdf",
    fileId: "missing",
    kind: "file",
    createdAt: new Date().toISOString(),
  });
  assert.throws(
    () => store.validateBackup(value),
    /missing an attached evidence file/,
  );
});

test("backup accepts uploaded evidence and rejects invalid base64 or executable links", () => {
  const value = backup();
  value.files.push({ id: "f1", type: "text/plain", data: btoa("hello") });
  value.cases[0].attachments.push({
    id: "a1",
    name: "Evidence.txt",
    fileId: "f1",
    kind: "file",
    size: 5,
    createdAt: new Date().toISOString(),
  });
  assert.equal(store.validateBackup(value), true);
  value.files[0].data = "not base64";
  assert.throws(() => store.validateBackup(value), /evidence file/);
  const linked = backup();
  linked.cases[0].attachments.push({
    id: "a2",
    name: "Evidence",
    kind: "link",
    value: "javascript:alert(1)",
    createdAt: new Date().toISOString(),
  });
  assert.throws(() => store.validateBackup(linked), /http and https/);
});

test("untrusted settings cannot carry prototype pollution keys", () => {
  const value = backup();
  value.settings = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => store.validateBackup(value), /unsupported property/);
  assert.equal({}.polluted, undefined);
});

test("paper locations and Google Drive evidence survive backups with strict URL validation", () => {
  const value = backup();
  value.cases[0].attachments.push({
    id: "paper",
    name: "Signed paper copy",
    kind: "paper",
    value: "Cabinet B / fictional sample folder",
    createdAt: new Date().toISOString(),
  });
  value.cases[0].attachments.push({
    id: "drive",
    name: "Drive document",
    kind: "drive",
    value: "https://docs.google.com/document/d/fictional/edit",
    createdAt: new Date().toISOString(),
  });
  assert.equal(store.validateBackup(value), true);
  value.cases[0].attachments[1].value =
    "https://docs.google.com.attacker.example/document";
  assert.throws(
    () => store.validateBackup(value),
    /Google Drive or Google Docs/,
  );
  value.cases[0].attachments[1].value =
    "http://drive.google.com/file/d/fictional";
  assert.throws(
    () => store.validateBackup(value),
    /Google Drive or Google Docs/,
  );
});

test("a storage-unavailable environment rejects writes instead of claiming data was saved", async () => {
  await assert.rejects(store.init(), /cannot save local records/);
  await assert.rejects(
    store.saveCase(backup().cases[0]),
    /cannot save local records/,
  );
});

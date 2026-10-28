const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../dist/model.js");
const store = require("../dist/data.js");

function portable(settings, cases = []) {
  return { format: "weekwise", version: 1, cases, settings, files: [] };
}

test("the Default library migrates an existing customized single template defensively", () => {
  const legacy = { template: model.template().slice(0, 2) };
  legacy.template[0].title = "Previously customized activity";
  const before = structuredClone(legacy),
    library = model.getTemplates(legacy);
  assert.equal(library.length, 1);
  assert.equal(library[0].id, "default");
  assert.equal(library[0].name, "Default");
  assert.deepEqual(library[0].activities, legacy.template);
  assert.equal(model.getDefaultTemplateId(legacy), "default");
  library[0].activities[0].title = "Only this returned snapshot changes";
  assert.deepEqual(legacy, before);
  assert.equal(model.getTemplates({})[0].activities.length, 19);
  assert.equal(store.validateBackup(portable(legacy)), true);
});

test("named templates and copies keep independent activity identities and valid defaults", () => {
  const custom = model.newTemplate({
    name: "  Short Review  ",
    activities: model.template().slice(0, 2),
  });
  const copied = model.copyTemplate(custom, "Another Review");
  assert.equal(custom.name, "Short Review");
  assert.notEqual(custom.id, copied.id);
  assert.ok(
    custom.activities.every(
      (activity, index) => activity.id !== copied.activities[index].id,
    ),
  );
  copied.activities[0].title = "Changed copy";
  assert.notEqual(custom.activities[0].title, copied.activities[0].title);
  assert.deepEqual(model.newTemplate({ name: "Blank" }).activities, []);
  const settings = {
    templates: [custom, copied],
    defaultTemplateId: copied.id,
  };
  assert.equal(model.getDefaultTemplateId(settings), copied.id);
  assert.equal(
    model.getDefaultTemplateId({ ...settings, defaultTemplateId: "removed" }),
    custom.id,
  );
  const normalized = model.getTemplates(settings);
  normalized[0].name = "Detached";
  assert.equal(settings.templates[0].name, "Short Review");
  assert.equal(store.validateBackup(portable(settings)), true);
});

test("case creation snapshots a named template so later edits and deletion do not alter the case", () => {
  const source = model.newTemplate({
    name: "Custom Patient Plan",
    activities: model.template().slice(0, 3),
  });
  const record = model.createCase({
    name: "Template test patient",
    startDate: "2026-11-01",
    dueDate: "2026-12-31",
    template: source.activities,
    templateId: source.id,
    templateName: source.name,
  });
  assert.equal(record.sourceTemplateId, source.id);
  assert.equal(record.sourceTemplateName, source.name);
  assert.ok(
    record.tasks.every(
      (task, index) => task.id !== source.activities[index].id,
    ),
  );
  source.name = "Renamed later";
  source.activities[0].title = "Edited later";
  source.activities.pop();
  assert.equal(record.tasks.length, 3);
  assert.notEqual(record.tasks[0].title, source.activities[0].title);
  assert.equal(record.sourceTemplateName, "Custom Patient Plan");
  assert.equal(
    store.validateBackup(
      portable(
        { templates: model.getTemplates({}), defaultTemplateId: "default" },
        [record],
      ),
    ),
    true,
  );
});

test("template libraries reject duplicate names/IDs, invalid defaults, dates and activities", () => {
  const original = model.getTemplates({})[0];
  const copied = model.copyTemplate(original, "Copy");
  function validate(templates, defaultTemplateId = original.id) {
    return store.validateBackup(portable({ templates, defaultTemplateId }));
  }
  assert.throws(() => validate([]), /at least one/);
  assert.throws(
    () => validate([original, { ...copied, name: " default " }]),
    /names must be unique/,
  );
  assert.throws(
    () => validate([original, { ...copied, id: original.id }]),
    /Duplicate template/,
  );
  assert.throws(() => validate([original], "missing"), /default template/);
  assert.throws(
    () => validate([{ ...original, createdAt: "not a date" }]),
    /creation date/,
  );
  assert.throws(() => model.newTemplate({ name: " " }), /template name/);
  assert.throws(
    () =>
      model.newTemplate({
        name: "Broken",
        activities: [{ title: "Task", week: 6 }],
      }),
    /week/,
  );
  assert.throws(
    () =>
      model.newTemplate({
        name: "Broken",
        activities: [{ title: "", week: 1 }],
      }),
    /title/,
  );
  const legacyRecord = model.createCase({
    name: "Old case",
    startDate: "2026-11-01",
  });
  assert.equal(store.validateBackup(portable({}, [legacyRecord])), true);
  assert.throws(
    () =>
      store.validateBackup(
        portable({}, [{ ...legacyRecord, sourceTemplateName: "" }]),
      ),
    /source template name/,
  );
});

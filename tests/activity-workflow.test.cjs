const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../dist/model.js");
const store = require("../dist/data.js");

function create(activities) {
  return model.createCase({
    name: "Fictional workflow patient",
    startDate: "2026-11-01",
    dueDate: "2026-12-31",
    template: activities,
  });
}

function portable(cases = [], settings = {}) {
  return { format: "weekwise", version: 1, cases, settings, files: [] };
}

test("single-week legacy activities retain their dates and ranges end at the selected week", () => {
  const record = create([
    { title: "Single week", week: 2 },
    { title: "Collect ratings", week: 2, endWeek: 4 },
    { title: "Long report", week: 1, endWeek: 5 },
  ]);
  const [single, ratings, report] = record.tasks;
  assert.equal(model.activityEndWeek(single), 2);
  assert.equal(model.activitySpansWeeks(single), false);
  assert.equal(single.dueDate, "2026-12-10");
  assert.equal(model.activityStartDate(record, single), "2026-12-04");
  assert.equal(model.activitySpansWeeks(ratings), true);
  assert.equal(ratings.dueDate, "2026-12-24");
  assert.equal(model.activityStartDate(record, ratings), "2026-12-04");
  assert.equal(report.dueDate, record.dueDate);
  assert.equal(model.activityStartDate(record, report), "2026-11-27");
  assert.equal(store.validateBackup(portable([record])), true);
});

test("template snapshots and copies preserve activity options and reset individual progress", () => {
  const original = model.newTemplate({
    name: "Extended Report",
    activities: [
      {
        title: "Prepare and submit report",
        week: 1,
        endWeek: 5,
        requiresSubmission: true,
        written: true,
        done: true,
      },
    ],
  });
  const copied = model.copyTemplate(original);
  const settings = {
    templates: [original, copied],
    defaultTemplateId: original.id,
  };
  const snapshot = model.getTemplates(settings)[0];
  const record = create(snapshot.activities);
  for (const entry of [original, copied, snapshot]) {
    assert.equal(entry.activities[0].week, 1);
    assert.equal(entry.activities[0].endWeek, 5);
    assert.equal(entry.activities[0].requiresSubmission, true);
    assert.equal("written" in entry.activities[0], false);
    assert.equal("done" in entry.activities[0], false);
  }
  assert.notEqual(original.activities[0].id, copied.activities[0].id);
  assert.notEqual(record.tasks[0].id, original.activities[0].id);
  assert.equal(record.tasks[0].endWeek, 5);
  assert.equal(record.tasks[0].requiresSubmission, true);
  assert.equal(record.tasks[0].written, false);
  assert.equal(record.tasks[0].done, false);
  assert.equal(record.tasks[0].dueDate, "2026-12-31");
  copied.activities[0].endWeek = 3;
  copied.activities[0].requiresSubmission = false;
  assert.equal(original.activities[0].endWeek, 5);
  assert.equal(record.tasks[0].endWeek, 5);
  assert.equal(record.tasks[0].requiresSubmission, true);
  assert.equal(store.validateBackup(portable([record], settings)), true);
});

test("Written and Submitted transitions keep final completion separate and never mutate the original", () => {
  const activity = create([
    { title: "Report", week: 5, requiresSubmission: true },
  ]).tasks[0];
  const written = model.setActivityChecks(activity, { written: true });
  assert.equal(activity.written, false);
  assert.equal(written.written, true);
  assert.equal(written.done, false);
  assert.equal(model.isAwaitingSubmission(written), true);
  assert.deepEqual(model.progress({ tasks: [written] }), {
    done: 0,
    total: 1,
    percent: 0,
  });
  const submitted = model.setActivityChecks(written, { done: true });
  assert.equal(submitted.done, true);
  assert.equal(submitted.written, true);
  assert.equal(model.isAwaitingSubmission(submitted), false);
  assert.deepEqual(model.progress({ tasks: [submitted] }), {
    done: 1,
    total: 1,
    percent: 100,
  });
  const unsubmitted = model.setActivityChecks(submitted, { done: false });
  assert.equal(unsubmitted.done, false);
  assert.equal(unsubmitted.written, true);
  assert.equal(model.isAwaitingSubmission(unsubmitted), true);
  const unwritten = model.setActivityChecks(submitted, { written: false });
  assert.equal(unwritten.written, false);
  assert.equal(unwritten.done, false);
  const directlySubmitted = model.setActivityChecks(activity, { done: true });
  assert.equal(directlySubmitted.written, true);
  assert.equal(directlySubmitted.done, true);
  assert.equal(
    model.isAwaitingSubmission({ written: true, done: false }),
    false,
  );
  assert.throws(
    () => model.setActivityChecks(activity, { written: "yes" }),
    /completion state/,
  );
});

test("old backups and omitted Written state remain valid without validation rewriting records", () => {
  const record = create([{ title: "Legacy activity", week: 3 }]);
  delete record.tasks[0].written;
  record.tasks[0].done = true;
  const backup = portable([record], { template: model.template() });
  const original = structuredClone(backup);
  assert.equal(store.validateBackup(backup), true);
  assert.deepEqual(backup, original);
  record.tasks[0].requiresSubmission = true;
  assert.equal(store.validateBackup(backup), true);
  const unsubmitted = model.setActivityChecks(record.tasks[0], { done: false });
  assert.equal(unsubmitted.written, true);
  assert.equal(model.isAwaitingSubmission(unsubmitted), true);
  record.tasks[0].written = false;
  assert.throws(() => store.validateBackup(backup), /must also be written/);
});

test("invalid week spans and nonboolean workflow flags are rejected in case creation and templates", () => {
  for (const options of [
    { week: 3, endWeek: 2 },
    { week: 1, endWeek: 6 },
    { week: 1, endWeek: 2.5 },
    { week: 1, endWeek: null },
    { week: 1, requiresSubmission: "yes" },
  ]) {
    const activity = { title: "Invalid activity", ...options };
    assert.throws(() => create([activity]), /week|flag/);
    assert.throws(
      () => model.newTemplate({ name: "Invalid", activities: [activity] }),
      /week|flag/,
    );
  }
});

test("backup and sync validation check optional activity fields while preserving valid values", () => {
  const record = create([
    { title: "Report", week: 2, endWeek: 5, requiresSubmission: true },
  ]);
  record.tasks[0] = model.setActivityChecks(record.tasks[0], { written: true });
  const template = model.newTemplate({
    name: "Report Template",
    activities: record.tasks,
  });
  const settings = { templates: [template], defaultTemplateId: template.id };
  const backup = JSON.parse(JSON.stringify(portable([record], settings)));
  assert.equal(store.validateBackup(backup), true);
  assert.equal(
    store.validateSync({
      cases: backup.cases,
      settings: backup.settings,
      files: [],
    }),
    true,
  );
  assert.equal(backup.cases[0].tasks[0].endWeek, 5);
  assert.equal(backup.cases[0].tasks[0].written, true);
  assert.equal(model.isAwaitingSubmission(backup.cases[0].tasks[0]), true);
  for (const [field, value] of [
    ["endWeek", 1],
    ["endWeek", 6],
    ["endWeek", "5"],
    ["requiresSubmission", 1],
    ["written", "true"],
  ]) {
    const invalid = structuredClone(backup);
    invalid.cases[0].tasks[0][field] = value;
    assert.throws(() => store.validateBackup(invalid), /end week|flag/);
    assert.throws(
      () =>
        store.validateSync({
          cases: invalid.cases,
          settings: invalid.settings,
          files: [],
        }),
      /end week|flag/,
    );
    if (field !== "written") {
      const invalidTemplate = structuredClone(backup);
      invalidTemplate.settings.templates[0].activities[0][field] = value;
      assert.throws(
        () => store.validateBackup(invalidTemplate),
        /end week|flag/,
      );
    }
  }
});

test("fresh fictional demos show all writing stages and different week ranges", () => {
  const demo = model.makeDemo();
  const waiting = demo.find((record) => record.name === "Alex Morgan");
  assert.ok(waiting.tasks.some(model.isAwaitingSubmission));
  const notWritten = demo.find((record) => record.name === "Jamie Rivera");
  assert.ok(
    notWritten.tasks.some(
      (task) => task.requiresSubmission && !task.written && !task.done,
    ),
  );
  const rangeCase = demo.find((record) => record.name === "Avery Brooks");
  const range = rangeCase.tasks.find(
    (task) => task.title === "Parent rating scales",
  );
  assert.equal(range.week, 2);
  assert.equal(range.endWeek, 4);
  assert.equal(
    range.dueDate,
    model.taskDue(rangeCase.startDate, rangeCase.dueDate, 4),
  );
  const fullRange = rangeCase.tasks.find(
    (task) => task.title === "Cognitive and processing testing",
  );
  assert.equal(fullRange.week, 1);
  assert.equal(fullRange.endWeek, 5);
  assert.equal(fullRange.dueDate, rangeCase.dueDate);
  const completed = demo.find((record) => record.name === "Jordan Lee");
  assert.ok(
    completed.tasks.some(
      (task) => task.requiresSubmission && task.written && task.done,
    ),
  );
  assert.equal(store.validateBackup(portable(demo)), true);
});

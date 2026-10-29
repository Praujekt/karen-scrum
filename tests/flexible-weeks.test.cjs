const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../dist/model.js");
const store = require("../dist/data.js");

function plan() {
  return model.newTemplate({
    name: "Fictional Flexible Assessment",
    activities: [
      { title: "Initial review", week: 1, priority: "high" },
      { title: "Required interview", week: 2, mandatory: true },
      { title: "Ratings", week: 3, optional: true },
      {
        title: "Extended report",
        week: 2,
        endWeek: 4,
        requiresSubmission: true,
        mandatory: true,
      },
      { title: "Submission", week: 5, mandatory: true },
    ],
  });
}

function create(template = plan()) {
  return model.createCase({
    name: "Fictional Flexible Patient",
    startDate: "2026-11-01",
    dueDate: "2026-12-31",
    weekCount: model.getWeekCount(template),
    template: template.activities,
    templateId: template.id,
    templateName: template.name,
    notes: "Retain this case note.",
  });
}

function backup(cases = [], settings = {}) {
  return { format: "weekwise", version: 1, cases, settings, files: [] };
}

test("legacy plans remain five weeks and flexible date math stays anchored to the final deadline", () => {
  assert.equal(model.getWeekCount({}), 5);
  assert.equal(model.getWeekCount({ weekCount: 520 }), 520);
  assert.equal(model.plannedStartDate({ dueDate: "2026-12-31" }), "2026-11-27");
  assert.equal(model.getWeekCount(model.newTemplate({ name: "Empty" })), 5);
  const extended = model.newTemplate({
    name: "Eight Weeks",
    weekCount: 8,
    activities: [
      { title: "Long assessment", week: 1, endWeek: 8, mandatory: true },
    ],
  });
  const record = create(extended);
  assert.equal(record.weekCount, 8);
  assert.equal(record.tasks[0].dueDate, record.dueDate);
  assert.equal(
    model.taskDue(record.startDate, record.dueDate, 1, 8),
    "2026-11-12",
  );
  assert.equal(model.activityStartDate(record, record.tasks[0]), "2026-11-06");
  assert.equal(model.plannedStartDate(record), "2026-11-06");
  assert.equal(model.taskDue("2024-01-01", "2024-03-28", 1, 5), "2024-02-29");
  assert.equal(model.taskDue("2026-10-01", "2026-11-22", 1, 3), "2026-11-08");
  const longPlan = model.newTemplate({
    name: "Maximum",
    weekCount: 520,
    activities: [{ title: "Final task", week: 520 }],
  });
  assert.equal(create(longPlan).tasks[0].dueDate, "2026-12-31");
});

test("appending template weeks and copying a flexible plan preserve existing work independently", () => {
  const original = plan(),
    before = structuredClone(original);
  const expanded = model.resizeTemplateWeeks(original, 8);
  assert.equal(expanded.weekCount, 8);
  assert.deepEqual(expanded.activities, original.activities);
  const copied = model.copyTemplate(expanded, "Independent Copy");
  assert.equal(copied.weekCount, 8);
  assert.deepEqual(
    copied.activities.map(({ id, ...task }) => task),
    expanded.activities.map(({ id, ...task }) => task),
  );
  assert.ok(
    copied.activities.every(
      (task, index) => task.id !== expanded.activities[index].id,
    ),
  );
  copied.activities[1].mandatory = false;
  expanded.activities[0].title = "Changed only here";
  assert.deepEqual(original, before);
  assert.equal(original.activities[1].mandatory, true);
  const snapshot = model.getTemplates({ templates: [expanded] })[0];
  assert.equal(snapshot.weekCount, 8);
  assert.equal(snapshot.activities[1].mandatory, true);
  assert.equal(snapshot.activities[0].priority, "high");
});

test("removing populated first, middle, or last template weeks never drops activities", () => {
  const original = plan(),
    before = structuredClone(original);
  for (const removedWeek of [1, 2, 3, 5]) {
    const next = model.removeTemplateWeek(original, removedWeek);
    assert.equal(next.weekCount, 4);
    assert.deepEqual(
      next.activities.map((task) => task.id),
      original.activities.map((task) => task.id),
    );
    assert.deepEqual(
      next.activities.map(({ week, endWeek, ...task }) => task),
      original.activities.map(({ week, endWeek, ...task }) => task),
    );
    assert.ok(
      next.activities.every(
        (task) =>
          task.week >= 1 &&
          model.activityEndWeek(task) <= 4 &&
          model.activityEndWeek(task) >= task.week,
      ),
    );
  }
  const withoutSecond = model.removeTemplateWeek(original, 2);
  assert.equal(withoutSecond.activities[1].week, 2);
  assert.equal(withoutSecond.activities[2].week, 2);
  assert.deepEqual(
    [withoutSecond.activities[3].week, withoutSecond.activities[3].endWeek],
    [2, 3],
  );
  const last = model.removeTemplateWeek(original, 5);
  assert.equal(last.activities.at(-1).week, 4);
  assert.deepEqual(original, before);
});

test("shortening a template keeps first/last phases and compresses ranges proportionally", () => {
  const original = plan(),
    shorter = model.resizeTemplateWeeks(original, 3);
  assert.deepEqual(
    shorter.activities.map((task) => task.week),
    [1, 2, 2, 2, 3],
  );
  assert.deepEqual(
    [shorter.activities[3].week, shorter.activities[3].endWeek],
    [2, 3],
  );
  assert.equal(shorter.activities.filter((task) => task.mandatory).length, 3);
  const oneWeek = model.resizeTemplateWeeks(original, 1);
  assert.ok(
    oneWeek.activities.every(
      (task) => task.week === 1 && model.activityEndWeek(task) === 1,
    ),
  );
  assert.equal(oneWeek.activities.length, original.activities.length);
});

test("condensing a case reschedules every activity but preserves progress, notes, evidence, and identity", () => {
  const template = plan(),
    templateBefore = structuredClone(template),
    record = create(template);
  record.tasks[0].done = true;
  record.tasks[3] = model.setActivityChecks(record.tasks[3], { written: true });
  record.tasks[3].dueDate = "2026-12-22";
  record.status = "in_progress";
  record.attachments.push({
    id: "evidence-reference",
    name: "Paper report",
    kind: "paper",
    value: "Locked cabinet, drawer A",
    createdAt: record.createdAt,
  });
  const before = structuredClone(record),
    condensed = model.condenseCase(record, 3);
  assert.equal(condensed.weekCount, 3);
  assert.equal(model.plannedStartDate(condensed), "2026-12-11");
  for (const key of [
    "id",
    "name",
    "startDate",
    "dueDate",
    "status",
    "createdAt",
    "updatedAt",
    "sourceTemplateId",
    "sourceTemplateName",
    "notes",
    "attachments",
  ])
    assert.deepEqual(condensed[key], before[key]);
  assert.deepEqual(
    condensed.tasks.map((task) => task.dueDate),
    ["2026-12-17", "2026-12-24", "2026-12-24", "2026-12-31", "2026-12-31"],
  );
  assert.deepEqual(
    condensed.tasks.map(({ week, endWeek, dueDate, ...task }) => task),
    before.tasks.map(({ week, endWeek, dueDate, ...task }) => task),
  );
  assert.equal(condensed.tasks[3].written, true);
  assert.equal(condensed.tasks[3].done, false);
  assert.deepEqual(model.progress(condensed), model.progress(record));
  assert.equal(condensed.tasks.filter((task) => task.mandatory).length, 3);
  assert.equal(store.validateBackup(backup([condensed])), true);
  condensed.notes[0].text = "Independent preview copy";
  assert.deepEqual(record, before);
  assert.deepEqual(template, templateBefore);
});

test("case expansion moves the final deadline later while preserving all existing activity dates and progress", () => {
  const template = plan(),
    record = create(template);
  record.tasks[0].done = true;
  record.tasks[3] = model.setActivityChecks(record.tasks[3], { written: true });
  record.tasks[3].dueDate = "2026-12-22";
  const before = structuredClone(record),
    expanded = model.resizeCaseWeeks(record, 11);
  assert.equal(expanded.weekCount, 11);
  assert.deepEqual(
    expanded.tasks.map((task) => [task.week, model.activityEndWeek(task)]),
    record.tasks.map((task) => [task.week, model.activityEndWeek(task)]),
  );
  assert.deepEqual(
    expanded.tasks.map((task) => task.dueDate),
    record.tasks.map((task) => task.dueDate),
  );
  assert.equal(expanded.dueDate, "2027-02-11");
  assert.equal(model.dateDiff(record.dueDate, expanded.dueDate), 42);
  assert.equal(
    model.plannedStartDate(expanded),
    model.plannedStartDate(record),
  );
  assert.equal(expanded.startDate, record.startDate);
  assert.deepEqual(expanded.tasks, record.tasks);
  assert.deepEqual(expanded.notes, record.notes);
  assert.deepEqual(expanded.attachments, record.attachments);
  assert.equal(store.validateBackup(backup([expanded])), true);
  assert.deepEqual(record, before);
  assert.equal(template.weekCount, 5);
  const oneWeek = model.condenseCase(record, 1);
  assert.ok(
    oneWeek.tasks.every(
      (task) =>
        task.week === 1 &&
        model.activityEndWeek(task) === 1 &&
        task.dueDate === record.dueDate,
    ),
  );
  assert.equal(oneWeek.tasks.length, record.tasks.length);
  record.tasks[0].dueDate = "2026-12-05";
  const unchanged = model.resizeCaseWeeks(record, model.getWeekCount(record));
  assert.deepEqual(unchanged, record);
  assert.notEqual(unchanged, record);
});

test("priority ranks mandatory and high-priority work without changing normal activities", () => {
  assert.deepEqual(
    [
      {},
      { priority: "normal" },
      { priority: "high" },
      { mandatory: true },
      { priority: "high", mandatory: true },
    ].map(model.activityPriority),
    [0, 0, 1, 2, 2],
  );
  const record = model.createCase({
    name: "One Week",
    startDate: "2026-12-01",
    weekCount: 1,
  });
  assert.equal(record.dueDate, "2026-12-07");
  assert.equal(record.tasks.length, 19);
  assert.ok(
    record.tasks.every(
      (task) => task.week === 1 && model.activityEndWeek(task) === 1,
    ),
  );
});

test("flexible plans and flags validate through backups/sync without mutating legacy data", () => {
  const template = model.resizeTemplateWeeks(plan(), 9),
    record = create(template);
  const portable = backup([record], {
    templates: [template],
    defaultTemplateId: template.id,
  });
  const before = structuredClone(portable);
  assert.equal(store.validateBackup(portable), true);
  assert.equal(
    store.validateSync({
      cases: portable.cases,
      settings: portable.settings,
      files: [],
    }),
    true,
  );
  assert.deepEqual(portable, before);
  const legacy = create();
  delete legacy.weekCount;
  const legacyBefore = structuredClone(legacy);
  assert.equal(
    store.validateBackup(backup([legacy], { template: model.template() })),
    true,
  );
  assert.deepEqual(legacy, legacyBefore);
});

test("invalid counts, out-of-plan weeks, conflicting flags, and invalid resize actions are rejected", () => {
  const original = plan(),
    record = create(original);
  for (const value of [0, -1, model.MAX_WEEKS + 1, 2.5, "3", null]) {
    assert.throws(() => model.getWeekCount({ weekCount: value }), /weeks/);
    assert.throws(
      () => model.newTemplate({ name: "Invalid", weekCount: value }),
      /weeks/,
    );
    const invalid = structuredClone(record);
    invalid.weekCount = value;
    assert.throws(() => store.validateBackup(backup([invalid])), /week count/);
  }
  for (const fields of [
    { week: 6 },
    { endWeek: 6 },
    { mandatory: "yes" },
    { priority: "urgent" },
    { mandatory: true, optional: true },
  ]) {
    const activity = { title: "Invalid", week: 1, ...fields };
    assert.throws(
      () => model.newTemplate({ name: "Invalid", activities: [activity] }),
      /week|flag|priority|mandatory/,
    );
  }
  assert.throws(
    () => model.removeTemplateWeek(model.resizeTemplateWeeks(original, 1), 1),
    /at least one/,
  );
  assert.throws(() => model.removeTemplateWeek(original, 0), /existing week/);
  assert.throws(() => model.condenseCase(record, 5), /fewer weeks/);
  assert.throws(() => model.condenseCase(record, 8), /fewer weeks/);
  const settings = { templates: [original], defaultTemplateId: original.id };
  for (const [field, value] of [
    ["mandatory", 1],
    ["priority", "urgent"],
    ["week", 6],
  ]) {
    const invalid = backup(
      [structuredClone(record)],
      structuredClone(settings),
    );
    invalid.cases[0].tasks[0][field] = value;
    assert.throws(
      () => store.validateBackup(invalid),
      /flag|priority|activity/,
    );
    invalid.cases[0] = structuredClone(record);
    invalid.settings.templates[0].activities[0][field] = value;
    assert.throws(
      () => store.validateBackup(invalid),
      /flag|priority|activity/,
    );
  }
});

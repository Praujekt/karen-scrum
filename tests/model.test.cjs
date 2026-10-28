const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../dist/model.js");

test("the supplied 19 activities retain all five weeks and three optional activities", () => {
  const tasks = model.template();
  assert.equal(tasks.length, 19);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(
      (week) => tasks.filter((task) => task.week === week).length,
    ),
    [5, 4, 3, 4, 3],
  );
  assert.deepEqual(
    tasks.filter((task) => task.optional).map((task) => task.title),
    ["Send out ROI", "Student rating scales", "ADOS"],
  );
});

test("calendar math crosses leap days and daylight-saving boundaries without losing a day", () => {
  assert.equal(model.addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(model.addDays("2024-02-28", 2), "2024-03-01");
  assert.equal(model.dateDiff("2026-03-07", "2026-03-09"), 2);
  assert.equal(model.addDays("2026-11-01", -1), "2026-10-31");
  assert.throws(() => model.addDays("2026-02-30", 1), /valid/);
});

test("a normal 35-day case schedules activities at the end of their respective weeks", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((week) =>
      model.taskDue("2026-10-01", "2026-11-04", week),
    ),
    ["2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28", "2026-11-04"],
  );
});

test("a case opened November 1 backdates its five weeks from the December 31 final deadline", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((week) =>
      model.taskDue("2026-11-01", "2026-12-31", week),
    ),
    ["2026-12-03", "2026-12-10", "2026-12-17", "2026-12-24", "2026-12-31"],
  );
  assert.equal(model.addDays("2026-12-31", -34), "2026-11-27");
  for (let week = 1; week <= 5; week++) {
    assert.equal(
      model.taskDue("2026-10-01", "2026-12-31", week),
      model.taskDue("2026-12-01", "2026-12-31", week),
    );
  }
});

test("short and same-day runways retain earlier task deadlines instead of clamping them to case opening", () => {
  const record = model.createCase({
    name: "Short runway",
    startDate: "2026-12-28",
    dueDate: "2026-12-31",
  });
  assert.equal(record.tasks[0].dueDate, "2026-12-03");
  assert.ok(record.tasks[0].dueDate < record.startDate);
  assert.equal(record.tasks.at(-1).dueDate, record.dueDate);
  assert.equal(model.taskDue("2026-12-31", "2026-12-31", 1), "2026-12-03");
  assert.throws(
    () => model.taskDue("2026-10-02", "2026-10-01", 1),
    /on or after/,
  );
  assert.throws(
    () =>
      model.createCase({
        name: "Invalid runway",
        startDate: "2026-12-31",
        dueDate: "2026-12-30",
      }),
    /on or after/,
  );
});

test("backdating crosses leap day and daylight-saving changes in whole calendar weeks", () => {
  assert.equal(model.taskDue("2024-01-01", "2024-03-28", 1), "2024-02-29");
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((week) =>
      model.taskDue("2026-02-01", "2026-03-29", week),
    ),
    ["2026-03-01", "2026-03-08", "2026-03-15", "2026-03-22", "2026-03-29"],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((week) =>
      model.taskDue("2026-10-01", "2026-11-22", week),
    ),
    ["2026-10-25", "2026-11-01", "2026-11-08", "2026-11-15", "2026-11-22"],
  );
});

test("moving only the final due date shifts every default activity by the same number of days", () => {
  const before = model.createCase({
    name: "Before",
    startDate: "2026-11-01",
    dueDate: "2026-12-31",
  });
  const after = model.createCase({
    name: "After",
    startDate: "2026-11-01",
    dueDate: "2027-01-10",
  });
  assert.ok(
    before.tasks.every(
      (task, index) =>
        model.dateDiff(task.dueDate, after.tasks[index].dueDate) === 10,
    ),
  );
});

test("new cases clone activity IDs and store notes as individual dated entries", () => {
  const template = model.template();
  const record = model.createCase({
    name: "  Sample Patient  ",
    startDate: "2026-10-01",
    notes: "Initial Note",
    template,
  });
  assert.equal(record.name, "Sample Patient");
  assert.equal(record.dueDate, "2026-11-04");
  assert.equal(record.status, "open");
  assert.equal(record.notes[0].text, "Initial Note");
  assert.equal(record.tasks[0].done, false);
  assert.notEqual(record.tasks[0].id, template[0].id);
  record.tasks[0].title = "Custom activity";
  assert.notEqual(record.tasks[0].title, template[0].title);
  assert.deepEqual(model.progress(record), { done: 0, total: 19, percent: 0 });
  record.tasks[0].done = true;
  assert.deepEqual(model.progress(record), { done: 1, total: 19, percent: 5 });
});

test("all demo data is fictional and completion status remains an explicit choice", () => {
  const demo = model.makeDemo();
  assert.equal(demo.length, 6);
  assert.deepEqual(
    ["open", "in_progress", "completed"].map(
      (status) => demo.filter((record) => record.status === status).length,
    ),
    [2, 2, 2],
  );
  assert.ok(
    demo.every(
      (record) =>
        record.demo === true &&
        record.notes.length >= 1 &&
        record.notes.length <= 2,
    ),
  );
  assert.ok(
    demo.every((record) =>
      record.notes.every((note) => note.text.includes("Fictional example")),
    ),
  );
  assert.ok(
    demo.every(
      (record) =>
        record.startDate <= record.dueDate && record.attachments.length === 0,
    ),
  );
  assert.deepEqual(
    demo
      .filter((record) => record.status === "in_progress")
      .map((record) => model.progress(record).done),
    [12, 5],
  );
  assert.ok(
    demo
      .filter((record) => record.status === "completed")
      .every((record) => model.progress(record).percent === 100),
  );
  assert.ok(
    demo
      .filter((record) => record.status === "open")
      .every((record) => model.progress(record).done === 0),
  );
  assert.deepEqual(
    demo
      .filter((record) => record.status === "in_progress")
      .map((record) => model.dateDiff(model.today(), record.dueDate)),
    [5, -2],
  );
  assert.deepEqual(
    demo
      .filter((record) => record.status === "open")
      .map((record) => model.dateDiff(model.today(), record.dueDate)),
    [34, 20],
  );
  assert.deepEqual(
    demo
      .filter((record) => record.status === "completed")
      .map((record) => model.dateDiff(model.today(), record.dueDate)),
    [-8, -3],
  );
  const open = demo.find((record) => record.status === "open");
  open.tasks.forEach((task) => {
    task.done = true;
  });
  assert.equal(model.effectiveStatus(open), "open");
});

(function (root) {
  "use strict";

  const DAY = 86400000;
  const rows = [
    [1, "Assessment Plan Notification (teacher)"],
    [1, "Cumulative file review"],
    [1, "SEIS Review"],
    [1, "Structured Observation 1"],
    [1, "Unstructured Observation"],
    [2, "Assessment notification (parent)"],
    [2, "Parent rating scales"],
    [2, "Parent Interview"],
    [2, "Send out ROI", true],
    [3, "Structured Observation 2"],
    [3, "Teacher rating scales"],
    [3, "Teacher interview"],
    [4, "Student interview"],
    [4, "Cognitive and processing testing"],
    [4, "Student rating scales", true],
    [4, "ADOS", true],
    [5, "Finalize report"],
    [5, "Upload SEIS sections"],
    [5, "Submit paperwork"],
  ];

  function uid() {
    return root.crypto && root.crypto.randomUUID
      ? root.crypto.randomUUID()
      : "ww-" +
          Date.now().toString(36) +
          "-" +
          Math.random().toString(36).slice(2, 12);
  }

  function ordinal(iso) {
    if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso))
      throw new Error("Enter a valid date.");
    const [year, month, day] = iso.split("-").map(Number);
    if (year < 1900 || year > 9999)
      throw new Error("Enter a date between 1900 and 9999.");
    const stamp = Date.UTC(year, month - 1, day);
    const date = new Date(stamp);
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new Error("Enter a valid calendar date.");
    }
    return stamp / DAY;
  }

  function today() {
    const date = new Date();
    return (
      date.getFullYear() +
      "-" +
      String(date.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(date.getDate()).padStart(2, "0")
    );
  }

  function addDays(iso, count) {
    if (!Number.isInteger(count))
      throw new Error("Days must be a whole number.");
    const date = new Date((ordinal(iso) + count) * DAY);
    const result = date.toISOString().slice(0, 10);
    ordinal(result);
    return result;
  }

  function dateDiff(a, b) {
    return ordinal(b) - ordinal(a);
  }

  function template() {
    return rows.map(([week, title, optional], index) => ({
      id: "default-" + (index + 1),
      title,
      week,
      optional: !!optional,
    }));
  }

  /**
   * Return the end of a template week by counting backward from the final due date.
   * Week 5 ends on dueDate; weeks 4, 3, 2, and 1 end 7, 14, 21, and 28 days earlier.
   * The full planned schedule starts 34 days before dueDate. startDate records when
   * the case opened and validates the case range; it never stretches or clamps tasks.
   * A short runway therefore intentionally produces activity dates before startDate.
   */
  function taskDue(startDate, dueDate, week) {
    if (dateDiff(startDate, dueDate) < 0)
      throw new Error("The due date must be on or after the start date.");
    if (!Number.isInteger(week) || week < 1 || week > 5)
      throw new Error("Choose a week from 1 to 5.");
    return addDays(dueDate, -(5 - week) * 7);
  }

  function createCase(options) {
    const input = options || {};
    const name = String(input.name || "").trim();
    if (!name || name.length > 200)
      throw new Error("Enter a patient name of up to 200 characters.");
    const startDate = input.startDate || today();
    const dueDate = input.dueDate || addDays(startDate, 34);
    if (dateDiff(startDate, dueDate) < 0)
      throw new Error("The due date must be on or after the start date.");
    const tasks = input.template || template();
    if (!Array.isArray(tasks) || tasks.length > 1000)
      throw new Error("Choose a valid activity template.");
    const now = new Date().toISOString();
    const notes = [];
    if (typeof input.notes === "string" && input.notes.trim())
      notes.push({ id: uid(), text: input.notes.trim(), createdAt: now });
    return {
      id: uid(),
      name,
      startDate,
      dueDate,
      status: "open",
      tasks: tasks.map((task) => {
        if (
          !task ||
          typeof task.title !== "string" ||
          !task.title.trim() ||
          task.title.length > 500
        )
          throw new Error("Every activity needs a title.");
        return {
          id: uid(),
          title: task.title.trim(),
          week: task.week,
          optional: !!task.optional,
          done: false,
          dueDate: taskDue(startDate, dueDate, task.week),
        };
      }),
      notes,
      attachments: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  function progress(record) {
    const tasks = Array.isArray(record.tasks) ? record.tasks : [];
    const done = tasks.filter((task) => task.done).length;
    return {
      done,
      total: tasks.length,
      percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    };
  }

  function effectiveStatus(record) {
    return record.status;
  }

  function makeDemo() {
    const current = today();
    const configurations = [
      [
        "Alex Morgan",
        -29,
        5,
        12,
        "in_progress",
        [
          "Fictional example: teacher interview notes have been organized. Week 4 activities are the next focus.",
          "Fictional example: final paperwork is due in five days. Check the report and upload steps before closing the case.",
        ],
      ],
      [
        "Jamie Rivera",
        -36,
        -2,
        5,
        "in_progress",
        [
          "Fictional example: the initial file reviews and observations are checked off.",
          "Fictional example: this sample case is overdue. Review the remaining dates and add a follow-up note.",
        ],
      ],
      [
        "Taylor Bennett",
        0,
        34,
        0,
        "open",
        [
          "Fictional example: a new case with the full five-week plan. Review the activities before beginning.",
        ],
      ],
      [
        "Avery Brooks",
        -14,
        20,
        0,
        "open",
        [
          "Fictional example: this plan is ready to start. Dates and optional activities can be adjusted for the case.",
        ],
      ],
      [
        "Jordan Lee",
        -42,
        -8,
        19,
        "completed",
        [
          "Fictional example: the report and submission steps are checked off. The case has been marked complete.",
          "Fictional example: completed cases remain available in the Completed view for reference.",
        ],
      ],
      [
        "Casey Parker",
        -37,
        -3,
        19,
        "completed",
        [
          "Fictional example: all activities are complete and the supporting documents have been organized.",
        ],
      ],
    ];
    return configurations.map(
      ([name, startOffset, dueOffset, checked, status, notes]) => {
        const record = createCase({
          name,
          startDate: addDays(current, startOffset),
          dueDate: addDays(current, dueOffset),
        });
        record.notes = notes.map((text) => ({
          id: uid(),
          text,
          createdAt: new Date().toISOString(),
        }));
        record.tasks.forEach((task, index) => {
          task.done = index < checked;
        });
        record.status = status;
        record.demo = true;
        return record;
      },
    );
  }

  const api = {
    uid,
    today,
    addDays,
    dateDiff,
    template,
    taskDue,
    createCase,
    progress,
    effectiveStatus,
    makeDemo,
  };
  root.WWModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

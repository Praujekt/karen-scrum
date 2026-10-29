(function (root) {
  "use strict";

  const DAY = 86400000;
  const TIME_ZONE = "America/Los_Angeles";
  const TIME_ZONE_LABEL = "Pacific Time";
  const MAX_WEEKS = 520;
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

  function today(now = new Date()) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
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

  function templateName(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100)
      throw new Error("Enter a template name of up to 100 characters.");
    return value.trim();
  }

  function activityEndWeek(activity) {
    return activity.endWeek ?? activity.week;
  }

  function getWeekCount(plan) {
    const count = plan && plan.weekCount !== undefined ? plan.weekCount : 5;
    if (!Number.isInteger(count) || count < 1 || count > MAX_WEEKS)
      throw new Error(
        "Choose a plan length from 1 to " + MAX_WEEKS + " weeks.",
      );
    return count;
  }

  function plannedStartDate(plan) {
    return addDays(plan.dueDate, -(getWeekCount(plan) * 7 - 1));
  }

  function activityPriority(activity) {
    return activity.mandatory ? 2 : activity.priority === "high" ? 1 : 0;
  }

  function activitySpansWeeks(activity) {
    return activityEndWeek(activity) > activity.week;
  }

  function isAwaitingSubmission(activity) {
    return !!(
      activity.requiresSubmission &&
      activity.written &&
      !activity.done
    );
  }

  function validateActivityOptions(activity, weekCount = 5) {
    if (
      !Number.isInteger(activity.week) ||
      activity.week < 1 ||
      activity.week > weekCount
    )
      throw new Error(
        "Choose a week from 1 to " + weekCount + " for every activity.",
      );
    if (
      activity.endWeek !== undefined &&
      (!Number.isInteger(activity.endWeek) ||
        activity.endWeek < activity.week ||
        activity.endWeek > weekCount)
    )
      throw new Error(
        "Choose an end week from the start week through Week " +
          weekCount +
          ".",
      );
    for (const flag of ["optional", "requiresSubmission", "mandatory"])
      if (activity[flag] !== undefined && typeof activity[flag] !== "boolean")
        throw new Error("Choose a valid " + flag + " flag for every activity.");
    if (
      activity.priority !== undefined &&
      !["normal", "high"].includes(activity.priority)
    )
      throw new Error("Choose a valid activity priority.");
    if (activity.mandatory && activity.optional)
      throw new Error("A mandatory activity cannot also be marked If Needed.");
  }

  /** Return a new activity while keeping Written and final completion consistent. */
  function setActivityChecks(activity, changes) {
    for (const flag of ["written", "done"])
      if (changes[flag] !== undefined && typeof changes[flag] !== "boolean")
        throw new Error("Choose a valid activity completion state.");
    const next = { ...activity };
    if (activity.requiresSubmission) {
      // A completed older snapshot may omit written; completion implies it.
      next.written = !!(activity.written || activity.done);
      if (changes.written !== undefined) {
        next.written = changes.written;
        if (!next.written) next.done = false;
      }
    }
    if (changes.done !== undefined) {
      next.done = changes.done;
      if (next.done && activity.requiresSubmission) next.written = true;
    }
    return next;
  }

  function cloneTemplateActivities(activities, freshIds, weekCount = 5) {
    if (!Array.isArray(activities) || activities.length > 1000)
      throw new Error("A template may contain up to 1000 activities.");
    const ids = new Set();
    return activities.map((activity) => {
      if (
        !activity ||
        typeof activity.title !== "string" ||
        !activity.title.trim() ||
        activity.title.trim().length > 500
      )
        throw new Error(
          "Every template activity needs a title of up to 500 characters.",
        );
      validateActivityOptions(activity, weekCount);
      const id = freshIds ? uid() : activity.id;
      if (
        typeof id !== "string" ||
        !id.trim() ||
        id.length > 200 ||
        ids.has(id)
      )
        throw new Error("Template activities need unique identifiers.");
      ids.add(id);
      return {
        id,
        title: activity.title.trim(),
        week: activity.week,
        optional: !!activity.optional,
        ...(activity.endWeek === undefined
          ? {}
          : { endWeek: activity.endWeek }),
        ...(activity.requiresSubmission === undefined
          ? {}
          : { requiresSubmission: activity.requiresSubmission }),
        ...(activity.priority === undefined
          ? {}
          : { priority: activity.priority }),
        ...(activity.mandatory === undefined
          ? {}
          : { mandatory: activity.mandatory }),
      };
    });
  }

  /** Defensive library snapshots; migrate the former single template without losing edits. */
  function getTemplates(settings) {
    const preferences = settings || {};
    if (Array.isArray(preferences.templates) && preferences.templates.length) {
      return preferences.templates.map((entry) => ({
        id: entry.id,
        name: templateName(entry.name),
        weekCount: getWeekCount(entry),
        activities: cloneTemplateActivities(
          entry.activities,
          false,
          getWeekCount(entry),
        ),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));
    }
    const now = new Date().toISOString();
    return [
      {
        id: "default",
        name: "Default",
        weekCount: 5,
        activities: cloneTemplateActivities(
          preferences.template || template(),
          false,
        ),
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  function getDefaultTemplateId(settings) {
    const templates = getTemplates(settings);
    return templates.some(
      (entry) => entry.id === (settings || {}).defaultTemplateId,
    )
      ? settings.defaultTemplateId
      : (templates.find((entry) => entry.id === "default") || templates[0]).id;
  }

  function newTemplate(options) {
    const input = options || {},
      weekCount = getWeekCount(input),
      now = new Date().toISOString();
    return {
      id: uid(),
      name: templateName(input.name),
      weekCount,
      activities: cloneTemplateActivities(
        input.activities === undefined ? [] : input.activities,
        true,
        weekCount,
      ),
      createdAt: now,
      updatedAt: now,
    };
  }

  function copyTemplate(source, name) {
    if (!source || !Array.isArray(source.activities))
      throw new Error("Choose a template to copy.");
    return newTemplate({
      name: name === undefined ? source.name + " Copy" : name,
      activities: source.activities,
      weekCount: getWeekCount(source),
    });
  }

  /**
   * Return the end of a template week by counting backward from the final due date.
   * The final week ends on dueDate; each earlier week ends seven days earlier.
   * The default is five weeks. startDate records when the case opened and validates
   * the case range; it never stretches or clamps tasks. A short runway therefore
   * intentionally produces activity dates before startDate.
   */
  function taskDue(startDate, dueDate, week, weekCount = 5) {
    getWeekCount({ weekCount });
    if (dateDiff(startDate, dueDate) < 0)
      throw new Error("The due date must be on or after the start date.");
    if (!Number.isInteger(week) || week < 1 || week > weekCount)
      throw new Error("Choose a week from 1 to " + weekCount + ".");
    return addDays(dueDate, -(weekCount - week) * 7);
  }

  function activityStartDate(record, activity) {
    return addDays(
      taskDue(
        record.startDate,
        record.dueDate,
        activity.week,
        getWeekCount(record),
      ),
      -6,
    );
  }

  function clonePlan(plan) {
    return typeof root.structuredClone === "function"
      ? root.structuredClone(plan)
      : JSON.parse(JSON.stringify(plan));
  }

  function mapActivityWeeks(activity, mapWeek) {
    return {
      ...activity,
      week: mapWeek(activity.week),
      ...(activity.endWeek === undefined
        ? {}
        : { endWeek: mapWeek(activity.endWeek) }),
    };
  }

  function compressedWeek(week, sourceCount, targetCount) {
    return targetCount === 1 || sourceCount === 1
      ? 1
      : 1 + Math.round(((week - 1) * (targetCount - 1)) / (sourceCount - 1));
  }

  /** Adding weeks appends empty weeks; shortening redistributes every activity. */
  function resizeTemplateWeeks(plan, targetCount) {
    const sourceCount = getWeekCount(plan);
    getWeekCount({ weekCount: targetCount });
    cloneTemplateActivities(plan.activities, false, sourceCount);
    const copy = clonePlan(plan);
    copy.weekCount = targetCount;
    if (targetCount < sourceCount)
      copy.activities = copy.activities.map((activity) =>
        mapActivityWeeks(activity, (week) =>
          compressedWeek(week, sourceCount, targetCount),
        ),
      );
    return copy;
  }

  /** Removing a week moves its work to a remaining week instead of dropping it. */
  function removeTemplateWeek(plan, removedWeek) {
    const sourceCount = getWeekCount(plan);
    if (sourceCount === 1)
      throw new Error("Keep at least one week in the template.");
    if (
      !Number.isInteger(removedWeek) ||
      removedWeek < 1 ||
      removedWeek > sourceCount
    )
      throw new Error("Choose an existing week to remove.");
    cloneTemplateActivities(plan.activities, false, sourceCount);
    const copy = clonePlan(plan),
      targetCount = sourceCount - 1;
    copy.weekCount = targetCount;
    copy.activities = copy.activities.map((activity) =>
      mapActivityWeeks(activity, (week) =>
        week < removedWeek
          ? week
          : Math.min(week === removedWeek ? week : week - 1, targetCount),
      ),
    );
    return copy;
  }

  /** Extend without moving existing work; condense backward from the final date. */
  function resizeCaseWeeks(record, targetCount) {
    const sourceCount = getWeekCount(record);
    getWeekCount({ weekCount: targetCount });
    cloneTemplateActivities(record.tasks, false, sourceCount);
    taskDue(record.startDate, record.dueDate, sourceCount, sourceCount);
    const copy = clonePlan(record);
    if (targetCount === sourceCount) return copy;
    copy.weekCount = targetCount;
    if (targetCount > sourceCount) {
      copy.dueDate = addDays(record.dueDate, (targetCount - sourceCount) * 7);
      return copy;
    }
    copy.tasks = copy.tasks.map((activity) => {
      const next = mapActivityWeeks(activity, (week) =>
        compressedWeek(week, sourceCount, targetCount),
      );
      return {
        ...next,
        dueDate: taskDue(
          copy.startDate,
          copy.dueDate,
          activityEndWeek(next),
          targetCount,
        ),
      };
    });
    return copy;
  }

  /** The dedicated condense action accepts only shorter plans. */
  function condenseCase(record, targetCount) {
    if (targetCount >= getWeekCount(record))
      throw new Error("Choose fewer weeks than the current case plan.");
    return resizeCaseWeeks(record, targetCount);
  }

  function createCase(options) {
    const input = options || {};
    const name = String(input.name || "").trim();
    if (!name || name.length > 200)
      throw new Error("Enter a patient name of up to 200 characters.");
    const startDate = input.startDate || today();
    const weekCount = getWeekCount(input);
    const dueDate = input.dueDate || addDays(startDate, weekCount * 7 - 1);
    if (dateDiff(startDate, dueDate) < 0)
      throw new Error("The due date must be on or after the start date.");
    const tasks =
      input.template ||
      resizeTemplateWeeks({ weekCount: 5, activities: template() }, weekCount)
        .activities;
    if (!Array.isArray(tasks) || tasks.length > 1000)
      throw new Error("Choose a valid activity template.");
    const now = new Date().toISOString();
    const notes = [];
    if (typeof input.notes === "string" && input.notes.trim())
      notes.push({ id: uid(), text: input.notes.trim(), createdAt: now });
    const record = {
      id: uid(),
      name,
      startDate,
      dueDate,
      weekCount,
      status: "open",
      tasks: cloneTemplateActivities(tasks, true, weekCount).map((task) => ({
        ...task,
        written: false,
        done: false,
        dueDate: taskDue(startDate, dueDate, activityEndWeek(task), weekCount),
      })),
      notes,
      attachments: [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.templateId !== undefined) {
      if (
        typeof input.templateId !== "string" ||
        !input.templateId.trim() ||
        input.templateId.length > 200
      )
        throw new Error("Choose a valid case template.");
      record.sourceTemplateId = input.templateId;
    }
    if (input.templateName !== undefined)
      record.sourceTemplateName = templateName(input.templateName);
    return record;
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
        if (name === "Alex Morgan") {
          const report = record.tasks.find(
            (task) => task.title === "Finalize report",
          );
          report.requiresSubmission = true;
          report.written = true;
          record.notes[0].text =
            "Fictional example: the report is written and awaiting submission. Check the separate Written and Submitted boxes when each step is finished.";
        }
        if (name === "Jamie Rivera") {
          const report = record.tasks.find(
            (task) => task.title === "Finalize report",
          );
          report.requiresSubmission = true;
          record.notes[0].text =
            "Fictional example: the report has not yet been written. Its separate Written and Submitted boxes show the two steps still to finish.";
        }
        if (name === "Avery Brooks") {
          const ratings = record.tasks.find(
            (task) => task.title === "Parent rating scales",
          );
          ratings.endWeek = 4;
          ratings.dueDate = taskDue(
            record.startDate,
            record.dueDate,
            ratings.endWeek,
          );
          const testing = record.tasks.find(
            (task) => task.title === "Cognitive and processing testing",
          );
          testing.week = 1;
          testing.endWeek = 5;
          testing.dueDate = record.dueDate;
          record.notes[0].text =
            "Fictional example: parent rating scales span Weeks 2 through 4, and cognitive and processing testing spans Weeks 1 through 5. Adjust these case activities without changing the source template.";
        }
        if (name === "Jordan Lee") {
          const report = record.tasks.find(
            (task) => task.title === "Finalize report",
          );
          report.requiresSubmission = true;
          report.written = true;
        }
        record.status = status;
        record.demo = true;
        return record;
      },
    );
  }

  const api = {
    TIME_ZONE,
    TIME_ZONE_LABEL,
    MAX_WEEKS,
    uid,
    today,
    addDays,
    dateDiff,
    template,
    getTemplates,
    getDefaultTemplateId,
    newTemplate,
    copyTemplate,
    taskDue,
    getWeekCount,
    plannedStartDate,
    activityPriority,
    resizeTemplateWeeks,
    removeTemplateWeek,
    resizeCaseWeeks,
    condenseCase,
    activityEndWeek,
    activitySpansWeeks,
    activityStartDate,
    isAwaitingSubmission,
    setActivityChecks,
    createCase,
    progress,
    effectiveStatus,
    makeDemo,
  };
  root.WWModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

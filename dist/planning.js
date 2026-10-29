(function () {
  "use strict";

  function templateToolbar({ template, model: M, button, icon }) {
    const weeks = M.getWeekCount(template);
    return (
      '<div class="planning-toolbar"><p class="planning-template-count"><strong>' +
      weeks +
      (weeks === 1 ? " Week" : " Weeks") +
      '</strong><span aria-hidden="true">·</span><span>' +
      template.activities.length +
      (template.activities.length === 1 ? " Activity" : " Activities") +
      '</span></p><div class="planning-toolbar-actions">' +
      button("template-set-weeks", "Set Weeks", "secondary small") +
      button(
        "template-add-week",
        icon("plus") + " Add Week",
        "secondary small",
        weeks >= (M.MAX_WEEKS || 520) ? "disabled" : "",
      ) +
      "</div></div>"
    );
  }

  function weekActions({ week, weekCount, button, icon }) {
    return button(
      "template-remove-week",
      icon("trash") + " Remove Week",
      "ghost small danger planning-remove-week",
      'data-week="' +
        week +
        '" aria-label="Remove Week ' +
        week +
        '"' +
        (weekCount <= 1 ? " disabled" : ""),
    );
  }

  function defaultTarget(sourceWeeks, targetWeeks) {
    return Number.isInteger(targetWeeks) &&
      targetWeeks > 0 &&
      targetWeeks < sourceWeeks
      ? targetWeeks
      : Math.max(1, sourceWeeks - 2);
  }

  function condenseBody(options) {
    const { record, model: M } = options;
    const sourceWeeks = M.getWeekCount(record);
    const isEdit = options.mode === "edit";
    if (sourceWeeks <= 1 && !isEdit)
      return '<p class="planning-note">This case already uses a one-week plan.</p>';
    const targetWeeks = isEdit
      ? Number.isInteger(options.targetWeeks) &&
        options.targetWeeks >= 1 &&
        options.targetWeeks <= M.MAX_WEEKS
        ? options.targetWeeks
        : sourceWeeks
      : defaultTarget(sourceWeeks, options.targetWeeks);
    return (
      '<div class="field planning-week-field"><label for="condense-weeks">Number of Weeks</label>' +
      (isEdit
        ? '<input type="number" id="condense-weeks" name="weekCount" min="1" max="' +
          M.MAX_WEEKS +
          '" step="1" required value="' +
          targetWeeks +
          '">'
        : '<select id="condense-weeks" name="weekCount">' +
          Array.from({ length: sourceWeeks - 1 }, (_, index) => index + 1)
            .map(
              (weeks) =>
                '<option value="' +
                weeks +
                '"' +
                (weeks === targetWeeks ? " selected" : "") +
                ">" +
                weeks +
                (weeks === 1 ? " Week" : " Weeks") +
                "</option>",
            )
            .join("") +
          "</select>") +
      '</div><div id="condense-preview">' +
      condensePreview({ ...options, targetWeeks }) +
      "</div>"
    );
  }

  function importance(task) {
    return task.mandatory ? 2 : task.priority === "high" ? 1 : 0;
  }

  function activityBadges(task, M) {
    return (
      (task.mandatory
        ? '<span class="planning-badge planning-badge--mandatory">Mandatory</span>'
        : "") +
      (task.priority === "high"
        ? '<span class="planning-badge planning-badge--priority">High Priority</span>'
        : "") +
      (M.activitySpansWeeks(task)
        ? '<span class="planning-badge">Weeks ' +
          task.week +
          "–" +
          M.activityEndWeek(task) +
          "</span>"
        : "") +
      (task.done
        ? '<span class="planning-badge planning-badge--completed">Completed</span>'
        : "")
    );
  }

  function dateComparison(before, after, esc, fmt, full) {
    return before === after
      ? esc(fmt(after, full))
      : '<span class="planning-old-date">' +
          esc(fmt(before, full)) +
          '</span><span class="planning-date-arrow" aria-hidden="true"> → </span>' +
          esc(fmt(after, full));
  }

  function condensePreview({ record, targetWeeks, mode, model: M, esc, fmt }) {
    const sourceWeeks = M.getWeekCount(record);
    const revised =
      mode === "edit"
        ? M.resizeCaseWeeks(record, targetWeeks)
        : M.condenseCase(record, targetWeeks);
    const mandatory = revised.tasks.filter((task) => task.mandatory).length;
    const highPriority = revised.tasks.filter(
      (task) => task.priority === "high",
    ).length;
    const groups = Array.from({ length: targetWeeks }, (_, index) => index + 1)
      .map((week) => ({
        week,
        date: M.taskDue(revised.startDate, revised.dueDate, week, targetWeeks),
        tasks: revised.tasks
          .filter((task) => M.activityEndWeek(task) === week)
          .sort(
            (a, b) =>
              importance(b) - importance(a) || a.title.localeCompare(b.title),
          ),
      }))
      .filter(({ tasks }) => tasks.length);
    return (
      '<div class="planning-summary" role="status" aria-live="polite"><div class="planning-summary-grid"><div><span>Timeline</span><strong>' +
      sourceWeeks +
      " → " +
      targetWeeks +
      (targetWeeks === 1 ? " Week" : " Weeks") +
      "</strong></div><div><span>Planned Start</span><strong>" +
      dateComparison(
        M.plannedStartDate(record),
        M.plannedStartDate(revised),
        esc,
        fmt,
      ) +
      "</strong></div><div><span>Final Deadline</span><strong>" +
      dateComparison(record.dueDate, revised.dueDate, esc, fmt, true) +
      '</strong></div></div><div class="planning-retained"><strong>' +
      revised.tasks.length +
      (revised.tasks.length === 1 ? " Activity Kept" : " Activities Kept") +
      "</strong>" +
      (mandatory
        ? '<span class="planning-badge planning-badge--mandatory">' +
          mandatory +
          " Mandatory</span>"
        : "") +
      (highPriority
        ? '<span class="planning-badge planning-badge--priority">' +
          highPriority +
          " High Priority</span>"
        : "") +
      '</div></div><div class="planning-preview" role="region" aria-label="Revised Activity Schedule">' +
      (groups.length
        ? groups
            .map(
              ({ week, date, tasks }) =>
                '<section class="planning-preview-week"><h3><span>Week ' +
                week +
                '</span><time datetime="' +
                date +
                '">' +
                esc(fmt(date)) +
                "</time></h3><ul>" +
                tasks
                  .map(
                    (task) =>
                      '<li data-planning-task-id="' +
                      esc(task.id) +
                      '"><span class="planning-task-title">' +
                      esc(task.title) +
                      '</span><span class="planning-task-badges">' +
                      activityBadges(task, M) +
                      (task.dueDate !== date
                        ? '<time class="planning-badge planning-custom-date" datetime="' +
                          task.dueDate +
                          '">Due ' +
                          esc(fmt(task.dueDate)) +
                          "</time>"
                        : "") +
                      "</span></li>",
                  )
                  .join("") +
                "</ul></section>",
            )
            .join("")
        : '<p class="planning-empty">No activities in this case.</p>') +
      "</div>"
    );
  }

  window.KLPlanning = Object.freeze({
    templateToolbar,
    weekActions,
    condenseBody,
    condensePreview,
  });
})();

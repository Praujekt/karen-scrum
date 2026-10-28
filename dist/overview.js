(function () {
  "use strict";

  function render(options) {
    const {
      cases,
      throughDate,
      today,
      model: M,
      esc,
      icon,
      fmt,
      button,
    } = options;
    const active = cases.filter((record) => record.status !== "completed");
    const allActivities = active.flatMap((record) =>
      (record.tasks || [])
        .filter((task) => !task.done)
        .map((task) => ({ record, task })),
    );
    const sortActivities = (a, b) =>
      a.task.dueDate.localeCompare(b.task.dueDate) ||
      a.record.name.localeCompare(b.record.name) ||
      a.task.title.localeCompare(b.task.title);
    const upcoming = allActivities
      .filter(({ task }) => task.dueDate <= throughDate)
      .sort(sortActivities);
    const written = allActivities
      .filter(({ task }) => task.requiresSubmission && task.written)
      .sort(sortActivities);
    const caseDeadlines = active
      .filter((record) => record.dueDate <= throughDate)
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name),
      );
    const overdue = upcoming.filter(({ task }) => task.dueDate < today).length;
    const dueToday = upcoming.filter(
      ({ task }) => task.dueDate === today,
    ).length;
    const groups = new Map();
    upcoming.forEach((activity) => {
      const date = activity.task.dueDate;
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push(activity);
    });

    function urgency(date) {
      const days = M.dateDiff(today, date);
      if (days < 0)
        return {
          kind: "overdue",
          label:
            Math.abs(days) + (days === -1 ? " Day Overdue" : " Days Overdue"),
        };
      if (days === 0) return { kind: "today", label: "Due Today" };
      if (days === 1) return { kind: "soon", label: "Due Tomorrow" };
      if (days <= 7) return { kind: "soon", label: "Due in " + days + " Days" };
      return { kind: "later", label: "Due in " + days + " Days" };
    }

    function urgencyLabel(date) {
      const { kind, label } = urgency(date);
      return (
        '<span class="overview-urgency overview-urgency--' +
        kind +
        '"><span class="overview-signal" aria-hidden="true"></span>' +
        esc(label) +
        "</span>"
      );
    }

    function weekLabel(task) {
      const end = task.endWeek || task.week;
      return end > task.week
        ? "Weeks " + task.week + "–" + end
        : "Week " + task.week;
    }

    function openCase(record, small) {
      return button(
        "open-case",
        'Open Case <span class="overview-open-arrow">' +
          icon("arrow") +
          "</span>",
        "ghost" + (small ? " small" : ""),
        'data-id="' +
          esc(record.id) +
          '" aria-label="Open Case for ' +
          esc(record.name) +
          '"',
      );
    }

    function activityRow({ record, task }) {
      return (
        '<li class="overview-activity"><div class="overview-activity-copy"><p class="overview-activity-title">' +
        esc(task.title) +
        '</p><div class="overview-activity-meta"><span class="overview-patient">' +
        esc(record.name) +
        '</span><span class="overview-week">' +
        esc(weekLabel(task)) +
        "</span>" +
        (task.requiresSubmission
          ? '<span class="overview-stage' +
            (task.written ? " overview-stage--written" : "") +
            '">' +
            (task.written ? "Written" : "Not Written") +
            "</span>"
          : "") +
        "</div></div>" +
        openCase(record, true) +
        "</li>"
      );
    }

    function dateGroup([date, activities]) {
      return (
        '<section class="overview-date-group overview-date-group--' +
        urgency(date).kind +
        '" aria-labelledby="overview-day-' +
        esc(date) +
        '"><div class="overview-date-heading"><h3 id="overview-day-' +
        esc(date) +
        '"><time datetime="' +
        esc(date) +
        '">' +
        esc(fmt(date, true)) +
        '</time><span class="overview-day-count">' +
        activities.length +
        (activities.length === 1 ? " Activity" : " Activities") +
        "</span></h3>" +
        urgencyLabel(date) +
        '</div><ul class="overview-activity-list">' +
        activities.map(activityRow).join("") +
        "</ul></section>"
      );
    }

    function readyRow({ record, task }) {
      return (
        '<li class="overview-ready-item overview-ready-item--' +
        urgency(task.dueDate).kind +
        '"><p class="overview-activity-title">' +
        esc(task.title) +
        '</p><p class="overview-patient">' +
        esc(record.name) +
        '</p><div class="overview-ready-date"><time datetime="' +
        esc(task.dueDate) +
        '">Due ' +
        esc(fmt(task.dueDate)) +
        "</time>" +
        urgencyLabel(task.dueDate) +
        '</div><div class="overview-ready-actions">' +
        openCase(record, true) +
        button(
          "overview-submit",
          icon("check") + " Mark Submitted",
          "primary small",
          'data-case-id="' +
            esc(record.id) +
            '" data-id="' +
            esc(task.id) +
            '" aria-label="Mark ' +
            esc(task.title) +
            " for " +
            esc(record.name) +
            ' Submitted"',
        ) +
        "</div></li>"
      );
    }

    function caseDeadline(record) {
      return (
        '<li class="overview-case-deadline overview-case-deadline--' +
        urgency(record.dueDate).kind +
        '"><div><p class="overview-patient">' +
        esc(record.name) +
        '</p><p class="overview-case-date"><time datetime="' +
        esc(record.dueDate) +
        '">' +
        esc(fmt(record.dueDate)) +
        "</time></p>" +
        urgencyLabel(record.dueDate) +
        "</div>" +
        openCase(record, true) +
        "</li>"
      );
    }

    const presets = [7, 14, 30]
      .map((days) =>
        button(
          "overview-range",
          "Next " + days + " Days",
          "secondary small overview-range" +
            (throughDate === M.addDays(today, days)
              ? " overview-range--selected"
              : ""),
          'data-days="' +
            days +
            '" aria-pressed="' +
            (throughDate === M.addDays(today, days)) +
            '"',
        ),
      )
      .join("");

    return (
      '<div class="overview-page"><header class="page-header"><div><p class="eyebrow">Your Overview</p><h1>At a Glance</h1><p class="page-subtitle">A clear view of what needs your attention, through ' +
      esc(fmt(throughDate, true)) +
      '.</p></div><div class="header-actions">' +
      button("new-case", icon("plus") + " New Case", "primary") +
      '</div></header><section class="overview-window" aria-label="Deadline Window"><div class="overview-window-copy"><span class="overview-window-icon" aria-hidden="true">' +
      icon("calendar") +
      '</span><div><h2>Your Deadline Window</h2><p>Includes unfinished activities and case deadlines up to this date.</p></div></div><div class="overview-window-controls"><div class="overview-presets" role="group" aria-label="Deadline Window Presets">' +
      presets +
      '</div><div class="overview-date-field"><label for="overview-through">View Through</label><input type="date" id="overview-through" value="' +
      esc(throughDate) +
      '" aria-describedby="overview-window-help"></div></div><p class="overview-window-help" id="overview-window-help">Past-due work stays visible in your selected window. Dates follow Pacific Time.</p></section><section class="overview-stats" aria-label="Activities in Your Deadline Window"><article class="overview-stat' +
      (overdue ? " overview-stat--overdue" : " overview-stat--quiet") +
      '"><div class="overview-stat-heading"><span class="overview-signal" aria-hidden="true"></span><h2>Overdue Activities</h2></div><p class="overview-stat-value">' +
      overdue +
      '</p><p class="overview-stat-caption">' +
      (overdue
        ? "Past their due date. Start here."
        : "No overdue work in this window.") +
      '</p></article><article class="overview-stat' +
      (dueToday ? " overview-stat--today" : " overview-stat--quiet") +
      '"><div class="overview-stat-heading">' +
      icon("clock") +
      '<h2>Due Today</h2></div><p class="overview-stat-value">' +
      dueToday +
      '</p><p class="overview-stat-caption">' +
      esc(fmt(today)) +
      (throughDate < today
        ? " is outside this window."
        : " · Activities to finish today.") +
      '</p></article><article class="overview-stat overview-stat--total"><div class="overview-stat-heading">' +
      icon("calendar") +
      '<h2>Due by Selected Date</h2></div><p class="overview-stat-value">' +
      upcoming.length +
      '</p><p class="overview-stat-caption">Through ' +
      esc(fmt(throughDate)) +
      ' · Includes overdue activities.</p></article></section><div class="overview-columns"><section class="panel overview-deadlines" aria-labelledby="overview-deadlines-heading"><div class="overview-section-heading"><div><p class="overview-kicker">Your Next Steps</p><h2 id="overview-deadlines-heading">Upcoming Deadlines</h2></div><span class="overview-count">' +
      upcoming.length +
      '</span></div><p class="overview-section-description">Unfinished activities, with the earliest due dates first.</p>' +
      (upcoming.length
        ? '<div class="overview-date-groups">' +
          Array.from(groups).map(dateGroup).join("") +
          "</div>"
        : '<div class="overview-empty"><span class="overview-empty-icon">' +
          icon("check") +
          "</span><h3>No Activities Due in This Window</h3><p>" +
          (active.length
            ? "Your unfinished activities are due later. Choose a later date to see what is coming."
            : "Add a case to see the work ahead, or find past cases under Completed.") +
          "</p></div>") +
      '</section><aside class="overview-aside" aria-label="Submission and Case Deadlines"><section class="panel overview-ready" aria-labelledby="overview-ready-heading"><div class="overview-section-heading"><div><p class="overview-kicker">One More Step</p><h2 id="overview-ready-heading">Written, Not Submitted</h2></div><span class="overview-count">' +
      written.length +
      '</span></div><p class="overview-section-description">All written activities awaiting submission, including those beyond your selected date.</p>' +
      (written.length
        ? '<ul class="overview-ready-list">' +
          written.map(readyRow).join("") +
          "</ul>"
        : '<div class="overview-ready-empty">' +
          icon("check") +
          "<p>Nothing is waiting to be submitted. Activities appear here when you mark them Written.</p></div>") +
      '</section><section class="panel overview-case-deadlines" aria-labelledby="overview-case-heading"><div class="overview-section-heading"><div><p class="overview-kicker">Final Due Dates</p><h2 id="overview-case-heading">Case Deadlines</h2></div><span class="overview-count">' +
      caseDeadlines.length +
      '</span></div><p class="overview-section-description">Active cases due by ' +
      esc(fmt(throughDate)) +
      ", even when all their activities are checked off.</p>" +
      (caseDeadlines.length
        ? '<ul class="overview-case-list">' +
          caseDeadlines.map(caseDeadline).join("") +
          "</ul>"
        : '<p class="overview-no-cases">No active cases have a final deadline in this window.</p>') +
      "</section></aside></div></div>"
    );
  }

  window.KLOverview = Object.freeze({ render });
})();

(function () {
  "use strict";
  const M = window.WWModel,
    DB = window.WWStore,
    R = window.WWReminderClient,
    sync = window.WWSync.create({ DB });
  R.setWorkspaceProvider(() =>
    sync.isConnected()
      ? { ...sync.getConnection(), locked: !sync.isUnlocked() }
      : null,
  );
  const app = document.getElementById("app"),
    modal = document.getElementById("modal");
  let cases = [],
    settings = {},
    reminder = null,
    reminderError = "",
    route = "overview",
    selectedId = null;
  let filter = "active",
    query = "",
    detailTab = "activities",
    toastTimer,
    busy = false;
  let modalAction = null,
    lastFocus = null,
    syncQueue = Promise.resolve(),
    mutationQueue = Promise.resolve();
  let modalWorkspaceWrite = true,
    modalWorkspaceVersion = null,
    workspaceWriteDepth = 0,
    deferredToast = null,
    deferredModalClose = false,
    pendingReminderSync = false;
  async function reloadWorkspace() {
    [cases, settings] = await Promise.all([DB.getCases(), DB.getSettings()]);
    if (route === "case" && !cases.some((c) => c.id === selectedId)) {
      route = "cases";
      selectedId = null;
      window.location.hash = "cases";
    }
  }
  async function refreshWorkspace() {
    if (sync.isConnected() && sync.isUnlocked() && !sync.isConflicted()) {
      await sync.refresh();
      await reloadWorkspace();
    }
  }
  async function withWorkspaceWrite(work) {
    if (!sync.isConnected() || workspaceWriteDepth) return work();
    workspaceWriteDepth = 1;
    deferredToast = null;
    deferredModalClose = false;
    pendingReminderSync = false;
    let committed = false,
      result;
    try {
      result = await sync.withWrite(async () => {
        await reloadWorkspace();
        return work();
      });
      committed = true;
      return result;
    } finally {
      workspaceWriteDepth = 0;
      await reloadWorkspace();
      if (committed && deferredModalClose) closeModal();
      deferredModalClose = false;
      render();
      if (committed && deferredToast)
        toast(deferredToast.message, deferredToast.error);
      deferredToast = null;
      if (committed && pendingReminderSync) queueReminderSync();
      pendingReminderSync = false;
    }
  }
  function serialize(work) {
    const result = mutationQueue.then(work, work);
    mutationQueue = result.catch(() => {});
    return result;
  }
  const statusNames = {
    open: "Pending",
    in_progress: "In progress",
    completed: "Completed",
  };
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    folder:
      '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    calendar:
      '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-13 4h2m4 0h2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    circle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    arrow: '<path d="m9 5 7 7-7 7"/>',
    back: '<path d="m15 5-7 7 7 7"/>',
    edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
    link: '<path d="m10 14 4-4m-6 6-2 2a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0m4 0 2-2a4.2 4.2 0 0 1 6 6l-4 4a4.2 4.2 0 0 1-6 0" transform="translate(1 0)"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    leaf: '<path d="M20 4c-9-2-17 3-16 10 1 8 15 9 16-10ZM6 18 16 8"/>',
    settings:
      '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/>',
    shield:
      '<path d="m12 3 8 3v6c0 5-8 10-8 10S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    note: '<path d="M21 14V3H3v18h11ZM14 21v-7h7M7 8h10M7 12h4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
    external: '<path d="M14 3h7v7m0-7-11 11M11 3H3v18h18v-8"/>',
  };
  function icon(name) {
    return (
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      (paths[name] || paths.file) +
      "</svg>"
    );
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  }
  function fmt(value, full) {
    return new Date(value + "T12:00:00").toLocaleDateString(
      undefined,
      full
        ? { month: "long", day: "numeric", year: "numeric" }
        : { month: "short", day: "numeric" },
    );
  }
  function stamp(value) {
    return new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  function initials(name) {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((x) => Array.from(x)[0])
      .join("")
      .toUpperCase();
  }
  function activeCases() {
    return cases.filter((c) => c.status !== "completed");
  }
  function currentCase() {
    const c = cases.find((c) => c.id === selectedId);
    if (!c) throw new Error("This case could not be found.");
    return c;
  }
  function badge(c) {
    return (
      '<span class="badge ' +
      c.status.replace("_", "-") +
      '"><span class="status-dot"></span>' +
      statusNames[c.status] +
      "</span>"
    );
  }
  function dueText(date) {
    const days = M.dateDiff(M.today(), date);
    return days < 0
      ? Math.abs(days) + "d overdue"
      : days === 0
        ? "Due today"
        : days === 1
          ? "Due tomorrow"
          : "Due in " + days + " days";
  }
  function dueClass(date) {
    const d = M.dateDiff(M.today(), date);
    return d < 0 ? "overdue" : d <= 7 ? "soon" : "";
  }
  function progress(c) {
    const p = M.progress(c);
    return (
      '<div class="case-progress"><div class="progress-label"><span>' +
      p.done +
      " of " +
      p.total +
      " activities</span><strong>" +
      p.percent +
      '%</strong></div><div class="progress-track"><div class="progress-fill" style="width:' +
      p.percent +
      '%"></div></div></div>'
    );
  }
  function toast(message, error) {
    if (workspaceWriteDepth && !error) {
      deferredToast = { message, error };
      return;
    }
    const el = document.getElementById("toast");
    clearTimeout(toastTimer);
    el.textContent = message;
    el.className = "toast" + (error ? " error" : "");
    el.hidden = false;
    toastTimer = setTimeout(
      () => {
        el.hidden = true;
      },
      error ? 8000 : 4500,
    );
  }
  function button(action, label, kind, extra) {
    return (
      '<button type="button" class="button ' +
      (kind || "secondary") +
      '" data-action="' +
      action +
      '" ' +
      (extra || "") +
      ">" +
      label +
      "</button>"
    );
  }
  function empty(title, text, action) {
    return (
      '<div class="empty-state"><div class="empty-icon">' +
      icon("leaf") +
      "</div><h3>" +
      title +
      "</h3><p>" +
      text +
      "</p>" +
      (action || "") +
      "</div>"
    );
  }
  function header(eyebrow, title, subtitle, actions) {
    return (
      '<header class="page-header"><div><p class="eyebrow">' +
      eyebrow +
      "</p><h1>" +
      title +
      '</h1><p class="page-subtitle">' +
      subtitle +
      '</p></div><div class="header-actions">' +
      (actions || "") +
      "</div></header>"
    );
  }
  function demoBanner() {
    return settings.demo
      ? '<div class="demo-banner"><span>' +
          icon("info") +
          " <strong>Example workspace</strong> · All patient names and records are fictional.</span>" +
          button("clear-demo", "Remove examples", "ghost small") +
          "</div>"
      : "";
  }
  function nav(id, name, ic, count) {
    return (
      '<button class="nav-item ' +
      (route === id ? "active" : "") +
      '" data-action="navigate" data-route="' +
      id +
      '" ' +
      (route === id ? 'aria-current="page"' : "") +
      ">" +
      icon(ic) +
      "<span>" +
      name +
      "</span>" +
      (count == null ? "" : '<span class="nav-count">' + count + "</span>") +
      "</button>"
    );
  }
  function render() {
    if (workspaceWriteDepth) return;
    if (sync.isConnected() && !sync.isUnlocked()) {
      app.innerHTML =
        '<main class="loading-screen workspace-locked"><div class="brand-mark">' +
        icon("shield") +
        '</div><p class="eyebrow">Weekwise · Shared workspace</p><h1>Unlock your workspace.</h1>' +
        "<p>Sign in and enter your encryption passphrase to open the records on this device.</p>" +
        '<p class="form-help">Your passphrase is never saved. This browser’s case view stays hidden until unlocked.</p>' +
        '<div class="form-actions">' +
        button("unlock-workspace", "Unlock shared workspace", "primary") +
        button("disconnect-workspace", "Disconnect this browser", "secondary") +
        "</div></main>";
      return;
    }
    if (route === "case" && !cases.some((c) => c.id === selectedId))
      route = "overview";
    const titles = {
      overview: "Overview",
      cases: "All cases",
      upcoming: "Coming up",
      templates: "Activity template",
      settings: "Reminders & settings",
      case: "Case details",
    };
    app.innerHTML =
      '<div class="app-shell"><aside class="sidebar"><a href="#overview" class="brand" aria-label="Weekwise overview"><span class="brand-mark">' +
      icon("calendar") +
      '</span><span class="brand-name">weekwise<span class="brand-period">.</span></span></a><p class="workspace-label">Your workspace</p><nav class="nav-group" aria-label="Main navigation">' +
      nav("overview", "Overview", "grid") +
      nav("cases", "All cases", "folder", cases.length) +
      nav("upcoming", "Coming up", "calendar") +
      '</nav><div class="nav-divider"></div><p class="workspace-label">Make it yours</p><nav class="nav-group" aria-label="Workspace settings">' +
      nav("templates", "Activity template", "file") +
      nav("settings", "Reminders & settings", "bell") +
      '</nav><div class="sidebar-bottom"><div class="sidebar-illustration">' +
      icon("leaf") +
      '</div><div class="local-status">' +
      (sync.isConnected()
        ? "Encrypted workspace sync"
        : "Saved on this laptop") +
      "</div><p>Your work, one clear view.<br>" +
      (sync.isConnected()
        ? "Shared workspace connected."
        : "No cloud storage connected.") +
      '</p></div></aside><main class="main" id="main"><div class="topbar"><div class="breadcrumb">Workspace ' +
      icon("arrow") +
      "<strong>" +
      titles[route] +
      '</strong></div><div class="topbar-actions"><span class="save-indicator">' +
      icon("shield") +
      ' Local workspace</span><span class="today-date">' +
      new Date().toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }) +
      '</span><span class="profile-avatar" aria-label="Personal workspace">K</span></div></div>' +
      workspaceBanner() +
      demoBanner() +
      (route === "overview" || route === "cases"
        ? dashboard()
        : route === "case"
          ? detail()
          : route === "upcoming"
            ? upcoming()
            : route === "templates"
              ? templates()
              : settingsPage()) +
      '<footer class="page-footer"><span>Made for a little more peace of mind.</span><span>Weekwise · Personal workspace</span></footer></main></div>';
  }
  function stats() {
    const active = activeCases(),
      late = active.filter((c) => c.dueDate < M.today()).length;
    const values = [
      [
        "folder",
        "Open cases",
        active.length,
        active.filter((c) => c.status === "in_progress").length +
          " currently in progress",
        "active",
      ],
      [
        "calendar",
        "Cases due soon",
        active.filter((c) => M.dateDiff(M.today(), c.dueDate) <= 7).length,
        "Next 7 days" +
          (late ? " · " + late + " overdue" : " · including today"),
        "due",
      ],
      [
        "clock",
        "Pending cases",
        active.filter((c) => c.status === "open").length,
        "Ready to get started",
        "open",
      ],
      [
        "circle",
        "Total completed",
        cases.filter((c) => c.status === "completed").length,
        "All your completed cases",
        "completed",
      ],
    ];
    return (
      '<div class="stats-grid">' +
      values
        .map(
          ([ic, label, num, foot, f]) =>
            '<button class="stat-card" data-action="metric" data-filter="' +
            f +
            '"><span class="stat-icon">' +
            icon(ic) +
            '</span><span class="stat-label">' +
            label +
            '</span><strong class="stat-value">' +
            num +
            '</strong><span class="stat-foot">' +
            foot +
            "</span></button>",
        )
        .join("") +
      "</div>"
    );
  }
  function filteredCases() {
    return cases
      .filter(
        (c) =>
          (filter === "all" ||
            (filter === "active" && c.status !== "completed") ||
            (filter === "due" &&
              c.status !== "completed" &&
              M.dateDiff(M.today(), c.dueDate) <= 7) ||
            c.status === filter) &&
          c.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      )
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name),
      );
  }
  function toolbar() {
    const options = [
      ["active", "All active"],
      ["open", "Pending"],
      ["in_progress", "In progress"],
      ["completed", "Completed"],
      ["all", "All cases"],
    ];
    return (
      '<div class="toolbar"><label class="search-field">' +
      icon("search") +
      '<span class="sr-only">Search patients</span><input type="search" id="case-search" placeholder="Search patients…" value="' +
      esc(query) +
      '"></label><label class="sr-only" for="case-filter">Filter cases</label><select id="case-filter" class="filter-select">' +
      (filter === "due"
        ? '<option value="due" selected>Due soon & overdue</option>'
        : "") +
      options
        .map(
          ([value, label]) =>
            '<option value="' +
            value +
            '" ' +
            (value === filter ? "selected" : "") +
            ">" +
            label +
            "</option>",
        )
        .join("") +
      "</select></div>"
    );
  }
  function card(c, index) {
    const next = c.tasks
      .filter((t) => !t.done)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    return (
      '<button class="case-card" data-action="open-case" data-id="' +
      esc(c.id) +
      '"><span class="case-main"><span class="avatar avatar-' +
      (index % 4) +
      '">' +
      esc(initials(c.name)) +
      '</span><span class="case-info"><span class="case-name">' +
      esc(c.name) +
      '</span><span class="case-meta">' +
      (c.status === "completed"
        ? "Case completed"
        : next
          ? esc(next.title)
          : "All activities checked off") +
      '</span></span></span><span class="case-summary">' +
      badge(c) +
      progress(c) +
      '<span class="case-due ' +
      (c.status === "completed" ? "" : dueClass(c.dueDate)) +
      '"><strong>' +
      fmt(c.dueDate) +
      "</strong><small>" +
      (c.status === "completed" ? "Final deadline" : dueText(c.dueDate)) +
      '</small></span><span class="case-arrow">' +
      icon("arrow") +
      "</span></span></button>"
    );
  }
  function listContent() {
    const list = filteredCases();
    return list.length
      ? list.map(card).join("")
      : empty(
          cases.length
            ? "No cases in this view"
            : "A clearer caseload starts here",
          cases.length
            ? "Try another filter or patient name."
            : "Add your first patient to turn a final due date into a clear, five-week plan.",
          cases.length
            ? ""
            : button(
                "new-case",
                icon("plus") + " Add your first case",
                "primary",
              ) +
                '<div class="empty-demo">' +
                button("load-demo", "Try example cases", "ghost") +
                "</div>",
        );
  }
  function dashboard() {
    const isOverview = route === "overview";
    return (
      header(
        isOverview ? "A little clarity, every day" : "Your caseload",
        isOverview ? "Your work, at a glance." : "A place for every case.",
        "Keep the next step in sight, and the bigger picture in balance.",
        button("new-case", icon("plus") + " New case", "primary"),
      ) +
      stats() +
      '<div class="dashboard-grid"><section class="content-column"><div class="section-heading"><h2>' +
      (isOverview ? "Your cases" : "All cases") +
      '</h2><span class="muted small">' +
      activeCases().length +
      " active</span></div>" +
      toolbar() +
      '<div id="case-results" class="case-list">' +
      listContent() +
      '</div><div class="notice quiet">' +
      icon("calendar") +
      '<span><strong>Plan from the finish line.</strong> Set a final deadline and your weekly activity dates work backward from there.</span></div></section><aside class="aside-column">' +
      agendaPanel() +
      '<section class="panel workload-panel"><div class="section-heading"><h2>The weekly picture</h2>' +
      icon("leaf") +
      '</div><p class="muted small">Unfinished activities by plan week</p><div class="week-strip">' +
      [1, 2, 3, 4, 5]
        .map((w) => {
          const total = activeCases()
              .flatMap((c) => c.tasks)
              .filter((t) => t.week === w).length,
            n = activeCases()
              .flatMap((c) => c.tasks)
              .filter((t) => t.week === w && !t.done).length;
          return (
            '<div class="week-cell"><span class="week-number">W' +
            w +
            '</span><div class="week-bar"><span style="height:' +
            (total ? Math.max(6, (n / total) * 100) : 6) +
            '%"></span></div><span class="week-count">' +
            n +
            "</span></div>"
          );
        })
        .join("") +
      '</div></section><div class="tip-card"><span class="tip-icon">' +
      icon("shield") +
      "</span><h3>A workspace that stays with you.</h3><p>Cases and evidence are saved in this browser on this laptop. Download a backup to keep a separate copy.</p>" +
      button("backup", "Download backup " + icon("arrow"), "ghost small") +
      "</div></aside></div>"
    );
  }
  function agendaItems() {
    return activeCases()
      .flatMap((c) => c.tasks.filter((t) => !t.done).map((t) => ({ c, t })))
      .sort(
        (a, b) =>
          a.t.dueDate.localeCompare(b.t.dueDate) ||
          a.c.name.localeCompare(b.c.name),
      );
  }
  function agendaPanel() {
    const items = agendaItems().filter(
      (x) => M.dateDiff(M.today(), x.t.dueDate) <= 7,
    );
    return (
      '<section class="panel agenda-panel"><div class="section-heading"><h2>Needs a little attention</h2><span class="agenda-bell">' +
      icon("bell") +
      '</span></div><p class="muted small">Overdue & the next 7 days</p><div class="agenda-list">' +
      (items.length
        ? items
            .slice(0, 4)
            .map(
              ({ c, t }) =>
                '<button class="agenda-item" data-action="open-case" data-id="' +
                esc(c.id) +
                '"><span class="agenda-date ' +
                dueClass(t.dueDate) +
                '"><span class="day">' +
                Number(t.dueDate.slice(8)) +
                '</span><span class="month">' +
                new Date(t.dueDate + "T12:00:00").toLocaleDateString(
                  undefined,
                  { month: "short" },
                ) +
                '</span></span><span class="agenda-text"><strong>' +
                esc(t.title) +
                "</strong><span>" +
                esc(c.name) +
                '</span><small class="' +
                dueClass(t.dueDate) +
                '">' +
                dueText(t.dueDate) +
                "</small></span></button>",
            )
            .join("")
        : '<div class="agenda-clear">' +
          icon("circle") +
          "<strong>You have a little breathing room.</strong><p>No unfinished activities due in the next 7 days.</p></div>") +
      "</div>" +
      button(
        "navigate",
        "View upcoming work " + icon("arrow"),
        "ghost small",
        'data-route="upcoming"',
      ) +
      "</section>"
    );
  }
  function detail() {
    const c = currentCase(),
      p = M.progress(c);
    return (
      '<div class="detail-heading">' +
      button(
        "navigate",
        icon("back") + " All cases",
        "ghost small",
        'data-route="cases"',
      ) +
      "</div>" +
      header(
        "Patient case",
        esc(c.name),
        "Opened " +
          fmt(c.startDate) +
          ' <span class="dot-divider">·</span> Final deadline ' +
          fmt(c.dueDate, true),
        button("edit-case", icon("edit") + " Edit case", "secondary") +
          button("print", icon("file") + " Print plan", "secondary"),
      ) +
      '<div class="detail-grid"><section><div class="panel timeline-summary"><div class="section-heading"><h2>The path to completion</h2><strong>' +
      p.percent +
      "%</strong></div>" +
      progress(c) +
      '<div class="timeline-weeks">' +
      [1, 2, 3, 4, 5]
        .map((w) => {
          const ts = c.tasks.filter((t) => t.week === w),
            done = ts.filter((t) => t.done).length;
          return (
            '<div class="timeline-week ' +
            (done === ts.length && ts.length ? "done" : "") +
            '"><span>Week ' +
            w +
            "</span><strong>" +
            fmt(M.taskDue(c.startDate, c.dueDate, w)) +
            "</strong><small>" +
            done +
            "/" +
            ts.length +
            " done</small></div>"
          );
        })
        .join("") +
      '</div><p class="form-help">Weekly target dates work backward from ' +
      fmt(c.dueDate) +
      '. Each activity date can be changed.</p></div><div class="detail-tabs tabs" role="tablist" aria-label="Case information">' +
      [
        ["activities", "Activities", c.tasks.length],
        ["notes", "Notes", c.notes.length],
        ["evidence", "Evidence", c.attachments.length],
      ]
        .map(
          ([id, label, n]) =>
            '<button class="tab ' +
            (detailTab === id ? "active" : "") +
            '" data-action="detail-tab" data-tab="' +
            id +
            '" role="tab" aria-selected="' +
            (detailTab === id) +
            '" aria-controls="case-tab-panel">' +
            label +
            " <span>" +
            n +
            "</span></button>",
        )
        .join("") +
      '</div><div id="case-tab-panel" role="tabpanel" aria-label="' +
      detailTab +
      '">' +
      (detailTab === "activities"
        ? tasksView(c)
        : detailTab === "notes"
          ? notesView(c)
          : evidenceView(c)) +
      '</div></section><aside class="detail-sidebar"><section class="panel"><div class="section-heading"><h2>Case overview</h2>' +
      icon("folder") +
      '</div><div class="field"><label for="case-status">Status</label><select id="case-status">' +
      Object.entries(statusNames)
        .map(
          ([v, l]) =>
            '<option value="' +
            v +
            '" ' +
            (v === c.status ? "selected" : "") +
            ">" +
            (v === "open" ? "Open / pending" : l) +
            "</option>",
        )
        .join("") +
      '</select></div><dl class="info-grid"><div class="info-item"><dt>Final due date</dt><dd>' +
      fmt(c.dueDate, true) +
      '</dd></div><div class="info-item"><dt>Time remaining</dt><dd class="' +
      (c.status === "completed" ? "" : dueClass(c.dueDate)) +
      '">' +
      (c.status === "completed" ? "Case completed" : dueText(c.dueDate)) +
      '</dd></div><div class="info-item"><dt>Planned start</dt><dd>' +
      fmt(M.addDays(c.dueDate, -34)) +
      '</dd></div><div class="info-item"><dt>Activities complete</dt><dd>' +
      p.done +
      " of " +
      p.total +
      "</dd></div></dl>" +
      (c.startDate > M.addDays(c.dueDate, -34)
        ? '<div class="notice"><span>This case opened after the five-week plan starts. Review early activity dates for a shorter timeline.</span></div>'
        : "") +
      '</section><section class="tip-card"><h3>Every case has its own pace.</h3><p>Add or remove activities, edit their dates, and mark optional activities as needed for this patient.</p>' +
      button("add-task", icon("plus") + " Add activity", "secondary small") +
      '</section><div class="case-updated">Last updated ' +
      stamp(c.updatedAt) +
      "</div>" +
      button(
        "delete-case",
        icon("trash") + " Delete case",
        "ghost small danger",
      ) +
      "</aside></div>"
    );
  }
  function tasksView(c) {
    return (
      '<div class="section-heading"><p class="muted small">Check off each activity as it is finished.</p>' +
      button("add-task", icon("plus") + " Add activity", "secondary small") +
      "</div>" +
      [1, 2, 3, 4, 5]
        .map((w) => {
          const tasks = c.tasks
            .filter((t) => t.week === w)
            .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
          return (
            '<section class="task-week"><div class="week-heading"><span class="week-pill">' +
            String(w).padStart(2, "0") +
            "</span><h2>Week " +
            w +
            '</h2><span class="week-range">' +
            fmt(M.addDays(c.dueDate, -34 + (w - 1) * 7)) +
            " – " +
            fmt(M.taskDue(c.startDate, c.dueDate, w)) +
            '</span><span class="week-done">' +
            tasks.filter((t) => t.done).length +
            "/" +
            tasks.length +
            "</span></div>" +
            (tasks.length
              ? tasks
                  .map(
                    (t) =>
                      '<div class="task-row ' +
                      (t.done ? "is-done" : "") +
                      '"><label class="task-check"><input type="checkbox" data-task-check="' +
                      esc(t.id) +
                      '" ' +
                      (t.done ? "checked" : "") +
                      ' aria-label="Complete ' +
                      esc(t.title) +
                      '"><span class="task-title">' +
                      esc(t.title) +
                      (t.optional
                        ? '<span class="optional-tag">Optional</span>'
                        : "") +
                      '</span></label><div class="task-meta ' +
                      (!t.done && c.status !== "completed"
                        ? dueClass(t.dueDate)
                        : "") +
                      '">' +
                      fmt(t.dueDate) +
                      '</div><div class="task-actions"><button class="icon-button" data-action="edit-task" data-id="' +
                      esc(t.id) +
                      '" aria-label="Edit ' +
                      esc(t.title) +
                      '">' +
                      icon("edit") +
                      "</button></div></div>",
                  )
                  .join("")
              : '<p class="empty-week">No activities in this week.</p>') +
            "</section>"
          );
        })
        .join("")
    );
  }
  function notesView(c) {
    return (
      '<section class="panel"><form id="note-form"><div class="field"><label for="note-text">Add a case note</label><textarea id="note-text" name="text" rows="4" maxlength="50000" placeholder="Updates, conversations, or something to remember…" required></textarea></div><div class="form-actions"><button class="button primary" type="submit">' +
      icon("plus") +
      ' Add note</button></div></form></section><div class="note-list">' +
      (c.notes.length
        ? c.notes
            .slice()
            .reverse()
            .map(
              (n) =>
                '<article class="note-card"><div class="note-meta"><span>' +
                icon("note") +
                " " +
                stamp(n.createdAt) +
                '</span><div><button class="icon-button" data-action="edit-note" data-id="' +
                esc(n.id) +
                '" aria-label="Edit note">' +
                icon("edit") +
                '</button><button class="icon-button danger" data-action="delete-note" data-id="' +
                esc(n.id) +
                '" aria-label="Delete note">' +
                icon("trash") +
                '</button></div></div><p class="note-text">' +
                esc(n.text) +
                "</p></article>",
            )
            .join("")
        : empty(
            "A place for the details",
            "Keep useful updates and context together with this case.",
          )) +
      "</div>"
    );
  }
  function evidenceView(c) {
    return (
      '<section class="panel"><div class="section-heading"><div><h2>Keep the evidence together</h2><p class="form-help">Upload a copy or save a reference to an existing document.</p></div></div><div class="evidence-actions">' +
      button("upload", icon("upload") + " Upload files", "primary") +
      button(
        "add-reference",
        icon("link") + " Add document reference",
        "secondary",
      ) +
      '</div><p class="form-help">Upload documents, scans, or photos. Up to 25 MB per file and 100 MB across the workspace. Backups include uploaded evidence; connected shared workspaces sync encrypted copies.</p><input type="file" id="evidence-files" multiple hidden></section><div class="attachment-list">' +
      (c.attachments.length
        ? c.attachments
            .map(
              (a) =>
                '<article class="attachment-item"><span class="attachment-icon">' +
                icon(a.kind === "file" ? "file" : "link") +
                '</span><div class="attachment-info"><h3>' +
                esc(a.name) +
                "</h3><p>" +
                (a.kind === "file"
                  ? (a.size / 1024 < 1024
                      ? Math.ceil(a.size / 1024) + " KB"
                      : (a.size / 1048576).toFixed(1) + " MB") + " · Saved copy"
                  : a.kind === "path"
                    ? "Local file reference · " + esc(a.value)
                    : a.kind === "paper"
                      ? "Paper location · " + esc(a.value)
                      : a.kind === "drive"
                        ? "Google Drive · " + esc(a.value)
                        : esc(a.value)) +
                "</p></div>" +
                button(
                  a.kind === "file"
                    ? "download-file"
                    : ["path", "paper"].includes(a.kind)
                      ? "copy-path"
                      : "open-link",
                  icon(
                    a.kind === "file"
                      ? "download"
                      : ["path", "paper"].includes(a.kind)
                        ? "file"
                        : "external",
                  ) +
                    (a.kind === "file"
                      ? " Download"
                      : a.kind === "path"
                        ? " Copy path"
                        : a.kind === "paper"
                          ? " Copy location"
                          : " Open"),
                  "secondary small",
                  'data-id="' + esc(a.id) + '"',
                ) +
                '<button class="icon-button danger" data-action="delete-attachment" data-id="' +
                esc(a.id) +
                '" aria-label="Remove ' +
                esc(a.name) +
                '">' +
                icon("trash") +
                "</button></article>",
            )
            .join("")
        : empty(
            "The supporting details, in one place",
            "Attach reports, rating scales, signed forms, or a reference to where they are saved.",
          )) +
      "</div>"
    );
  }
  function upcoming() {
    const items = agendaItems(),
      horizon = M.addDays(M.today(), 7),
      inView = items.filter(({ t }) => t.dueDate <= horizon);
    const groups = new Map();
    for (const item of inView) {
      if (!groups.has(item.t.dueDate)) groups.set(item.t.dueDate, []);
      groups.get(item.t.dueDate).push(item);
    }
    return (
      header(
        "One step at a time",
        "What’s coming up.",
        "Overdue activities and everything due in the next 7 days.",
        button("new-case", icon("plus") + " New case", "primary"),
      ) +
      '<div class="upcoming-summary notice">' +
      icon("calendar") +
      "<span><strong>" +
      inView.length +
      " activities</strong> across " +
      new Set(inView.map((x) => x.c.id)).size +
      " cases need attention through " +
      fmt(horizon) +
      ".</span></div>" +
      (groups.size
        ? Array.from(groups)
            .map(
              ([date, items]) =>
                '<section class="task-week"><div class="week-heading"><h2>' +
                fmt(date, true) +
                '</h2><span class="badge ' +
                dueClass(date) +
                '">' +
                dueText(date) +
                "</span></div>" +
                items
                  .map(
                    ({ c, t }) =>
                      '<button class="upcoming-row" data-action="open-case" data-id="' +
                      esc(c.id) +
                      '"><span class="avatar">' +
                      esc(initials(c.name)) +
                      '</span><span class="upcoming-task"><strong>' +
                      esc(t.title) +
                      "</strong><span>" +
                      esc(c.name) +
                      " · Week " +
                      t.week +
                      "</span></span>" +
                      icon("arrow") +
                      "</button>",
                  )
                  .join("") +
                "</section>",
            )
            .join("")
        : empty(
            "You’re clear for the week",
            "No unfinished activities are due in the next 7 days. Review your cases to see the rest of the plan.",
            button("navigate", "View cases", "secondary", 'data-route="cases"'),
          ))
    );
  }
  function templates() {
    const ts = settings.template || M.template();
    return (
      header(
        "A thoughtful starting point",
        "Your activity template.",
        "New cases start here. Existing cases keep their own activities and dates.",
        button("template-add", icon("plus") + " Add activity", "primary"),
      ) +
      '<div class="notice">' +
      icon("calendar") +
      '<span><strong>Five weeks, planned backward.</strong> Week 5 ends on the final deadline. Each earlier week ends 7 days before the next.</span></div><div class="template-grid">' +
      [1, 2, 3, 4, 5]
        .map(
          (w) =>
            '<section class="panel"><div class="section-heading"><h2>Week ' +
            w +
            '</h2><span class="muted small">' +
            (5 - w) * 7 +
            ' days before due</span></div><div class="template-list">' +
            ts
              .filter((t) => t.week === w)
              .map(
                (t) =>
                  '<div class="template-row"><span class="template-check">' +
                  icon("check") +
                  "</span><span>" +
                  esc(t.title) +
                  (t.optional
                    ? '<small class="optional-tag">Optional</small>'
                    : "") +
                  '</span><button class="icon-button" data-action="template-edit" data-id="' +
                  esc(t.id) +
                  '" aria-label="Edit template ' +
                  esc(t.title) +
                  '">' +
                  icon("edit") +
                  "</button></div>",
              )
              .join("") +
            "</div>" +
            button(
              "template-add",
              "+ Add to week " + w,
              "ghost small",
              'data-week="' + w + '"',
            ) +
            "</section>",
        )
        .join("") +
      '</div><div class="form-actions">' +
      button("reset-template", "Restore original template", "secondary") +
      "</div>"
    );
  }
  function reminderDefaults() {
    return {
      enabled: false,
      channels: [],
      email: "",
      phone: "",
      daysAhead: 3,
      time: "09:00",
      includeOverdue: true,
    };
  }
  function workspaceBanner() {
    if (!sync.isConnected()) return "";
    const state = sync.getState();
    return (
      '<div class="demo-banner workspace-sync-banner"><span>' +
      icon("shield") +
      " <strong>Shared workspace</strong> · " +
      (state.lastError
        ? esc(state.lastError)
        : "Encrypted sync is connected. Refresh to see changes from another device.") +
      '</span><div class="header-actions">' +
      button("refresh-workspace", "Refresh shared workspace", "ghost small") +
      button("lock-workspace", "Lock", "ghost small") +
      "</div></div>"
    );
  }
  function workspaceConnectionPanel() {
    const connected = sync.isConnected(),
      connection = sync.getConnection(),
      state = sync.getState();
    return (
      '<section class="panel reminder-connection"><div class="section-heading"><div><h2>' +
      icon("folder") +
      ' Sync phone &amp; laptop</h2><p class="form-help">Use the same cases, notes, and evidence on both devices.</p></div><span class="badge ' +
      (connected ? "completed" : "open") +
      '">' +
      (connected ? "Shared workspace connected" : "Optional setup") +
      '</span></div><p class="form-help">A shared workspace stores an encrypted copy of your records. Each device needs the service address, sign-in details, and your encryption passphrase. Connected workspaces require a connection to save changes.</p>' +
      (connected
        ? '<p class="mono cloud-service-url">' +
          esc(connection.url) +
          '</p><p class="form-help">' +
          (connection.authType === "google"
            ? "Google sign-in"
            : "Private access key") +
          " · Encrypted version " +
          state.version +
          (state.updatedAt
            ? " · Last synced " + esc(stamp(state.updatedAt))
            : "") +
          "</p>"
        : "") +
      (state.lastError
        ? '<div class="form-error">' + esc(state.lastError) + "</div>"
        : "") +
      '<div class="form-actions">' +
      (connected
        ? button(
            "refresh-workspace",
            "Refresh shared workspace",
            "secondary small",
          ) +
          (connection.authType === "google"
            ? button("google-workspace", "Sign in to Google", "secondary small")
            : "") +
          button(
            "disconnect-workspace",
            "Disconnect this browser",
            "ghost small",
          )
        : button(
            "connect-workspace",
            "Connect shared workspace",
            "secondary",
          )) +
      '<a class="subtle-link" href="https://github.com/Praujekt/karen-scrum#readme" target="_blank" rel="noreferrer">Shared workspace setup ' +
      icon("external") +
      "</a></div>" +
      (!connected
        ? '<p class="form-help cloud-local-note">Requires a deployed workspace service. The example workspace works on this device without setup.</p>'
        : "") +
      "</section>"
    );
  }
  function workspaceModal(unlocking) {
    const connection = sync.getConnection();
    showModal(
      unlocking ? "Unlock shared workspace" : "Connect shared workspace",
      (unlocking
        ? '<p class="mono cloud-service-url">' +
          esc(connection.url) +
          '</p><p class="form-help">' +
          (connection.authType === "google"
            ? "Google sign-in will confirm your account, then your passphrase decrypts the records."
            : "Enter your encryption passphrase to decrypt the shared records.") +
          "</p>"
        : '<div class="notice"><span>If this service already has records, they replace the ' +
          cases.length +
          " cases on this device. Download a backup first if you need to keep them.</span></div>" +
          '<div class="form-actions">' +
          button("backup", "Download backup", "secondary small") +
          "</div>" +
          '<div class="field"><label for="workspace-url">Workspace URL</label><input id="workspace-url" type="url" name="url" required placeholder="https://your-workspace.workers.dev" autocomplete="off"></div>' +
          '<div class="field"><label for="workspace-auth">Sign-in method</label><select id="workspace-auth" name="authType"><option value="key">Private access key</option><option value="google">Google sign-in</option></select></div>' +
          '<div class="field" id="workspace-key-field"><label for="workspace-key">Workspace access key</label><input id="workspace-key" name="token" type="password" required minlength="32" maxlength="512" autocomplete="off"></div>' +
          '<div class="field" id="workspace-google-field" hidden><label for="workspace-client-id">Google client ID</label><input id="workspace-client-id" name="clientId" autocomplete="off"><p class="form-help">Use the OAuth client configured for your deployed workspace service.</p></div>') +
        '<div class="field"><label for="workspace-passphrase">Encryption passphrase</label><input id="workspace-passphrase" name="passphrase" type="password" required minlength="12" maxlength="1024" autocomplete="off"><p class="form-help">At least 12 characters. Use the same passphrase on each device; it cannot be recovered by the service.</p></div>',
      '<button type="submit" class="button primary">' +
        (unlocking ? "Unlock workspace" : "Connect workspace") +
        "</button>",
      async (fd) => {
        if (unlocking) {
          const token =
            connection.authType === "google"
              ? await window.WWGoogle.signIn(connection.clientId)
              : undefined;
          await sync.unlock(fd.get("passphrase"), token);
        } else {
          const authType = fd.get("authType"),
            clientId = fd.get("clientId").trim();
          const token =
            authType === "google"
              ? await window.WWGoogle.signIn(clientId)
              : fd.get("token").trim();
          const target = new URL(fd.get("url").trim());
          if (
            target.protocol !== "https:" ||
            target.pathname !== "/" ||
            target.username ||
            target.password ||
            target.search ||
            target.hash
          ) {
            throw new Error(
              "Use an HTTPS workspace origin without a path, query, or credentials.",
            );
          }
          if (
            reminder &&
            reminder.config.enabled &&
            (!R.hasCloud() || R.connectionUrl() !== target.origin)
          ) {
            await pauseReminders();
          }
          await sync.connect({
            url: fd.get("url").trim(),
            authType,
            clientId,
            token,
            passphrase: fd.get("passphrase"),
          });
        }
        await reloadWorkspace();
        reminder = null;
        try {
          reminder = await api("/api/reminders");
          reminderError = "";
        } catch (error) {
          reminderError = error.message;
        }
        queueReminderSync();
        closeModal();
        navigate("overview");
        toast(
          unlocking
            ? "Shared workspace unlocked."
            : "Shared workspace connected and records synced.",
        );
      },
      false,
      false,
    );
  }
  async function refreshSharedWorkspace() {
    try {
      await sync.refresh();
      await reloadWorkspace();
      queueReminderSync();
      render();
      toast("Shared workspace refreshed.");
    } catch (error) {
      render();
      throw error;
    }
  }
  function reminderConnectionPanel() {
    const cloud = R.hasCloud();
    return (
      '<section class="panel reminder-connection"><div class="section-heading"><div><h2>' +
      icon("shield") +
      (cloud ? " Cloud reminders" : "Reminders, even when the laptop is off") +
      '</h2><p class="form-help">' +
      (cloud
        ? "The cloud service runs the schedule. Your laptop can be off."
        : "Optional: connect a cloud service for delivery while this laptop is off.") +
      "</p></div>" +
      (cloud
        ? '<span class="badge ' +
          (reminderError ? "soon" : "completed") +
          '">' +
          (reminderError ? "Needs attention" : "Cloud connected") +
          "</span>"
        : "") +
      "</div>" +
      (cloud
        ? '<p class="mono cloud-service-url">' + esc(R.connectionUrl()) + "</p>"
        : "") +
      '<p class="form-help">Only counts, deadline dates, and delivery preferences go to the reminder service. Patient names, notes, and evidence are excluded from reminders.</p>' +
      (reminderError && cloud
        ? '<div class="form-error cloud-error" role="alert">' +
          esc(reminderError) +
          "</div>"
        : "") +
      '<div class="form-actions">' +
      (cloud
        ? button("retry-reminders", "Retry connection", "secondary small") +
          (reminderError && !R.usesWorkspace()
            ? button(
                "connect-cloud",
                "Update cloud connection",
                "secondary small",
              )
            : "") +
          (!R.usesWorkspace()
            ? button(
                "disconnect-cloud",
                "Disconnect cloud reminders",
                "ghost small",
              )
            : '<span class="form-help">Uses your shared workspace connection. Disable delivery below to pause reminders.</span>')
        : button("connect-cloud", "Connect cloud reminders", "secondary")) +
      '<a class="subtle-link" href="cloud-setup.html" target="_blank" rel="noreferrer">Cloud setup guide ' +
      icon("external") +
      "</a>" +
      "</div>" +
      (!cloud && reminder
        ? '<p class="form-help cloud-local-note">Local reminders are available while this laptop is awake and the local service is running. Connecting cloud reminders pauses the local schedule.</p>'
        : "") +
      "</section>"
    );
  }
  function connectCloudModal() {
    if (R.usesWorkspace())
      throw new Error(
        "Your shared workspace already provides the reminder connection.",
      );
    showModal(
      "Connect cloud reminders",
      '<p class="form-help">Use the HTTPS service URL and connection token from your Cloudflare reminder service. This does not upload patient records.</p>' +
        '<div class="field"><label for="cloud-url">Service URL</label><input id="cloud-url" name="url" type="url" required autocomplete="off" placeholder="https://your-reminders.workers.dev"></div>' +
        '<div class="field"><label for="cloud-token">Connection token</label><input id="cloud-token" name="token" type="password" required minlength="32" maxlength="512" autocomplete="off" spellcheck="false"><p class="form-help">Stored separately in this browser, excluded from case backups. Keep your original token somewhere secure.</p></div>',
      '<button type="submit" class="button primary">Connect service</button>',
      async (fd) => {
        const candidate = R.validate(fd.get("url"), fd.get("token"));
        if (
          R.hasCloud() &&
          R.connectionUrl().startsWith("https:") &&
          R.connectionUrl() !== candidate.url
        ) {
          throw new Error(
            "Disconnect the current cloud service before connecting a different URL.",
          );
        }
        R.checkStorage();
        await syncQueue;
        const remote = await R.request(
          "/api/reminders",
          "GET",
          undefined,
          candidate,
        );
        if (!R.hasCloud() && R.canUseLocal()) {
          let local = reminder;
          if (!local) {
            try {
              local = await R.request("/api/reminders");
            } catch (_) {}
          }
          if (local && local.config.enabled)
            reminder = await R.request("/api/reminders", "PUT", {
              config: { ...local.config, enabled: false },
              snapshot: snapshot(),
            });
        }
        const updated = await R.request(
          "/api/reminders",
          "PUT",
          { config: remote.config, snapshot: snapshot() },
          candidate,
        );
        R.save(candidate);
        reminder = updated;
        reminderError = "";
        closeModal();
        render();
        toast(
          "Cloud reminders connected. The latest deadline dates are synced.",
        );
      },
      false,
      false,
    );
  }
  async function refreshReminders() {
    await syncQueue;
    try {
      reminder = await api("/api/reminders");
      reminder = await api("/api/reminders/snapshot", "PUT", {
        snapshot: snapshot(),
      });
      reminderError = "";
      render();
      toast("Reminder connection refreshed and deadline dates synced.");
    } catch (error) {
      reminderError = error.message;
      render();
      throw error;
    }
  }
  async function pauseReminders() {
    await syncQueue;
    if (R.hasCloud() || reminder) {
      const current = reminder || (await api("/api/reminders"));
      reminder = await api("/api/reminders", "PUT", {
        config: { ...current.config, enabled: false },
        snapshot: { caseCount: 0, caseDueDates: [], taskDueDates: [] },
      });
      reminderError = "";
    }
  }
  function settingsPage() {
    const config = reminder ? reminder.config : reminderDefaults(),
      enabled = (reminder && reminder.configured) || {};
    return (
      header(
        "Make room for peace of mind",
        "A little help remembering.",
        "Choose how reminders fit your day, and keep a copy of your work.",
      ) +
      workspaceConnectionPanel() +
      reminderConnectionPanel() +
      '<div class="settings-grid"><section class="panel"><div class="section-heading"><div><h2>' +
      icon("bell") +
      ' Deadline reminders</h2><p class="form-help">A daily digest of task and case deadlines approaching.</p></div><span class="badge ' +
      (config.enabled ? "in-progress" : "open") +
      '">' +
      (!reminder && R.hasCloud()
        ? "Status unavailable"
        : config.enabled
          ? "Enabled"
          : "Off") +
      "</span></div>" +
      (!reminder
        ? '<div class="notice">' +
          icon("info") +
          (R.hasCloud()
            ? "<span>The cloud schedule could not be read. It may still be active. Retry the connection to review its settings and sync the latest dates.</span></div>"
            : R.canUseLocal()
              ? "<span>Start Weekwise with <strong>Start Weekwise.cmd</strong> to use local reminders, or connect a cloud service above.</span></div>"
              : "<span>Connect the optional cloud service above to enable reminders. Your cases can be used without it.</span></div>")
        : "") +
      '<form id="reminder-form"><div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" ' +
      (config.enabled ? "checked" : "") +
      '> Enable daily reminders</label></div><div class="form-grid"><div class="field"><label for="days-ahead">Remind me before deadlines</label><select id="days-ahead" name="daysAhead">' +
      [1, 2, 3, 5, 7, 14]
        .map(
          (n) =>
            '<option value="' +
            n +
            '" ' +
            (config.daysAhead === n ? "selected" : "") +
            ">" +
            n +
            " day" +
            (n === 1 ? "" : "s") +
            " ahead</option>",
        )
        .join("") +
      '</select></div><div class="field"><label for="reminder-time">Daily send time</label><input id="reminder-time" name="time" type="time" required value="' +
      esc(config.time) +
      '"><span class="form-help">' +
      (R.hasCloud()
        ? "Cloud schedule uses " + esc(R.currentTimeZone()) + " when saved."
        : "Uses this laptop’s local time.") +
      '</span></div></div><label class="checkbox-label"><input type="checkbox" name="includeOverdue" ' +
      (config.includeOverdue ? "checked" : "") +
      '> Include overdue work</label><hr><div class="field"><label class="checkbox-label"><input type="checkbox" name="channelEmail" ' +
      (config.channels.includes("email") ? "checked" : "") +
      '> Email reminders <span class="badge ' +
      (enabled.email ? "completed" : "open") +
      '">' +
      (enabled.email ? "Connected" : "Setup needed") +
      '</span></label><label for="reminder-email" class="sr-only">Reminder email address</label><input id="reminder-email" type="email" name="email" maxlength="254" placeholder="Her email address" value="' +
      esc(config.email) +
      '"></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="channelSms" ' +
      (config.channels.includes("sms") ? "checked" : "") +
      '> SMS reminders <span class="badge ' +
      (enabled.sms ? "completed" : "open") +
      '">' +
      (enabled.sms ? "Connected" : "Setup needed") +
      '</span></label><label for="reminder-phone" class="sr-only">Reminder phone number</label><input id="reminder-phone" type="tel" name="phone" maxlength="20" placeholder="+15551234567" value="' +
      esc(config.phone) +
      '"><span class="form-help">Include the country code. Provider charges may apply.</span></div><p class="form-help reminder-privacy">' +
      icon("shield") +
      ' Messages contain counts and dates only. Patient names, notes, and evidence are never included.</p><div id="reminder-error" class="form-error" role="alert" hidden></div><div class="form-actions"><button type="submit" class="button primary" ' +
      (!reminder ? "disabled" : "") +
      ">Save reminders</button>" +
      button(
        "test-reminder",
        "Send test reminder",
        "secondary",
        !reminder ? "disabled" : "",
      ) +
      '</div></form><details class="setup-details"><summary>Connect email or SMS</summary><p>Email uses <a href="https://resend.com/docs/introduction" target="_blank" rel="noreferrer">Resend</a>; SMS uses <a href="https://www.twilio.com/docs/messaging" target="_blank" rel="noreferrer">Twilio</a>. A cloud service runs the schedule while the laptop is off. <a href="cloud-setup.html" target="_blank" rel="noreferrer">Read the cloud setup guide</a>.</p><p>Local reminders are also available with Start Weekwise.cmd and provider credentials in the local .env file. Local delivery requires the laptop awake, online, and the service running.</p></details><div class="backup-status">' +
      (reminder && Object.keys(reminder.lastSent || {}).length
        ? Object.entries(reminder.lastSent)
            .map(
              ([channel, date]) =>
                esc(channel === "sms" ? "SMS" : "Email") +
                " last accepted: " +
                esc(stamp(date)),
            )
            .join("<br>")
        : "No scheduled reminders sent yet.") +
      (reminder && reminder.snapshotUpdatedAt
        ? "<p>Deadline dates last synced " +
          esc(stamp(reminder.snapshotUpdatedAt)) +
          ".</p>"
        : "") +
      (reminder && reminder.lastError
        ? '<p class="text-danger">' +
          esc(
            typeof reminder.lastError === "string"
              ? reminder.lastError
              : JSON.stringify(reminder.lastError),
          ) +
          "</p>"
        : "") +
      '</div></section><div><section class="panel"><div class="section-heading"><h2>' +
      icon("download") +
      ' Backup & restore</h2></div><p class="muted">Download all cases, notes, your template, and uploaded evidence in one portable backup.</p><div class="backup-buttons">' +
      button("backup", icon("download") + " Download backup", "primary") +
      button("restore", icon("upload") + " Restore backup", "secondary") +
      '</div><p class="form-help">Backups contain patient information and are not encrypted. Store them in an approved, secure location. Provider credentials are excluded.</p><p class="backup-status">' +
      (settings.lastBackup
        ? "Last backup downloaded " + stamp(settings.lastBackup)
        : "No backup downloaded yet.") +
      '</p></section><section class="tip-card"><h3>' +
      icon("shield") +
      ' Your workspace, your records.</h3><p>Each browser keeps a local copy. A connected shared workspace also stores encrypted copies for your other devices. Clearing browser data removes this device’s copy.</p><p>Reminder services receive only counts, dates, and delivery preferences. Connection credentials are stored separately and excluded from case backups.</p><p>Use your organization’s approved device and storage practices for patient records.</p></section><section class="panel danger-zone"><h3>Workspace data</h3><p class="form-help">Remove cases, uploaded copies, and the custom template. When shared sync is connected, clearing also updates the shared workspace.</p>' +
      button("clear-all", "Clear workspace…", "danger small") +
      "</section></div></div>"
    );
  }

  function showModal(
    title,
    body,
    footer,
    handler,
    wide,
    workspaceWrite = true,
  ) {
    modalWorkspaceWrite = workspaceWrite;
    modalWorkspaceVersion =
      workspaceWrite && sync.isConnected() && sync.isUnlocked()
        ? sync.getState().version
        : null;
    lastFocus = document.activeElement;
    modal.className = "modal" + (wide ? " wide" : "");
    modal.innerHTML =
      '<form id="modal-form"><div class="modal-header"><h2 id="modal-title">' +
      title +
      '</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="Close dialog">' +
      icon("close") +
      '</button></div><div class="modal-body">' +
      body +
      '<div id="modal-error" class="form-error" role="alert" hidden></div></div><div class="modal-footer">' +
      button("close-modal", "Cancel", "secondary") +
      (footer ||
        '<button type="submit" class="button primary">Save changes</button>') +
      "</div></form>";
    modalAction = handler;
    modal.showModal();
  }
  function closeModal() {
    if (workspaceWriteDepth) {
      deferredModalClose = true;
      return;
    }
    modal.querySelectorAll('input[type="password"]').forEach((input) => {
      input.value = "";
    });
    modal.close();
    modalAction = null;
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  }
  function confirmAction(title, text, label, handler, workspaceWrite = true) {
    showModal(
      title,
      "<p>" + text + "</p>",
      '<button type="submit" class="button danger">' + label + "</button>",
      handler,
      false,
      workspaceWrite,
    );
  }
  function caseModal(editing) {
    const c = editing ? currentCase() : null,
      start = c ? c.startDate : M.today(),
      due = c ? c.dueDate : M.addDays(start, 34);
    showModal(
      editing ? "Edit case" : "A new case, a clear plan",
      '<div class="field"><label for="patient-name">Patient name <span class="required">*</span></label><input id="patient-name" name="name" maxlength="200" required autocomplete="off" value="' +
        esc(c ? c.name : "") +
        '" placeholder="First and last name"></div><div class="form-grid"><div class="field"><label for="case-opened">Case opened</label><input id="case-opened" name="startDate" type="date" required value="' +
        start +
        '"></div><div class="field"><label for="final-due">Final due date <span class="required">*</span></label><input id="final-due" name="dueDate" type="date" required value="' +
        due +
        '"></div></div><div class="schedule-preview" id="schedule-preview"></div>' +
        (editing
          ? '<div class="field"><label class="checkbox-label"><input type="checkbox" name="shift" checked> Shift activity dates when the deadline changes</label><p class="form-help">Moves every activity by the same number of days, preserving custom spacing.</p></div>'
          : '<div class="field"><label for="initial-note">Initial note <span class="muted">(optional)</span></label><textarea id="initial-note" name="notes" maxlength="50000" rows="3" placeholder="Anything useful to know about this case…"></textarea></div><p class="form-help">Starts with your five-week activity template. You can customize everything afterward.</p>'),
      '<button type="submit" class="button primary">' +
        (editing ? "Save case" : "Create case") +
        "</button>",
      async (fd) => {
        if (editing) {
          const latest = cases.find((record) => record.id === c.id);
          if (!latest)
            throw new Error("This case was removed from the shared workspace.");
          const copy = structuredClone(latest),
            delta = M.dateDiff(latest.dueDate, fd.get("dueDate"));
          if (M.dateDiff(fd.get("startDate"), fd.get("dueDate")) < 0)
            throw new Error(
              "The final due date must be on or after the case opened date.",
            );
          copy.name = fd.get("name").trim();
          copy.startDate = fd.get("startDate");
          copy.dueDate = fd.get("dueDate");
          if (fd.has("shift"))
            copy.tasks.forEach((t) => {
              t.dueDate = M.addDays(t.dueDate, delta);
            });
          await saveCase(copy);
          closeModal();
          render();
          toast("Case updated.");
        } else {
          const fresh = M.createCase({
            name: fd.get("name"),
            startDate: fd.get("startDate"),
            dueDate: fd.get("dueDate"),
            notes: fd.get("notes"),
            template: settings.template || M.template(),
          });
          await saveCase(fresh);
          closeModal();
          selectedId = fresh.id;
          detailTab = "activities";
          navigate("case");
          toast("Case created. Your weekly dates are ready.");
        }
      },
      true,
    );
    updateSchedulePreview();
  }
  function updateSchedulePreview() {
    const el = modal.querySelector("#schedule-preview");
    if (!el) return;
    const start = modal.querySelector("[name=startDate]").value,
      due = modal.querySelector("[name=dueDate]").value;
    try {
      const planStart = M.addDays(due, -34);
      el.innerHTML =
        '<div class="schedule-preview-title">' +
        icon("calendar") +
        " Planned backward from " +
        fmt(due) +
        '</div><div class="schedule-preview-weeks">' +
        [1, 2, 3, 4, 5]
          .map(
            (w) =>
              "<span><small>Week " +
              w +
              "</small><strong>" +
              fmt(M.taskDue(start, due, w)) +
              "</strong></span>",
          )
          .join("") +
        '</div><p class="form-help">Plan starts ' +
        fmt(planStart) +
        "." +
        (start > planStart
          ? " Early activities predate the case opening; adjust them for a shorter timeline."
          : "") +
        "</p>";
    } catch (_) {
      el.innerHTML =
        '<p class="form-help">Choose a deadline on or after the case opened date to see the plan.</p>';
    }
  }
  function taskModal(id, template, week) {
    const c = template ? null : currentCase(),
      ts = template ? settings.template || M.template() : c.tasks,
      old = id ? ts.find((t) => t.id === id) : null;
    showModal(
      old ? "Edit activity" : "Add an activity",
      '<div class="field"><label for="activity-title">Activity name</label><input id="activity-title" name="title" maxlength="500" required value="' +
        esc(old ? old.title : "") +
        '"></div><div class="form-grid"><div class="field"><label for="activity-week">Plan week</label><select id="activity-week" name="week">' +
        [1, 2, 3, 4, 5]
          .map(
            (w) =>
              '<option value="' +
              w +
              '" ' +
              (w === (old ? old.week : week || 1) ? "selected" : "") +
              ">Week " +
              w +
              "</option>",
          )
          .join("") +
        "</select></div>" +
        (!template
          ? '<div class="field"><label for="activity-due">Activity due date</label><input id="activity-due" type="date" name="dueDate" required value="' +
            (old ? old.dueDate : M.taskDue(c.startDate, c.dueDate, week || 1)) +
            '"></div>'
          : "") +
        '</div><label class="checkbox-label"><input type="checkbox" name="optional" ' +
        (old && old.optional ? "checked" : "") +
        "> Optional / if necessary</label>" +
        (!template
          ? '<p class="form-help">Set a date that fits this case. It can differ from the weekly target.</p>'
          : ""),
      (old
        ? button(
            template ? "template-delete" : "delete-task",
            icon("trash") + " Remove activity",
            "danger small",
            'data-id="' + esc(old.id) + '"',
          )
        : "") +
        '<button type="submit" class="button primary">' +
        (old ? "Save activity" : "Add activity") +
        "</button>",
      async (fd) => {
        const t = {
          id: old ? old.id : M.uid(),
          title: fd.get("title").trim(),
          week: Number(fd.get("week")),
          optional: fd.has("optional"),
        };
        if (!t.title) throw new Error("Enter an activity name.");
        if (template) {
          const updated = structuredClone(settings.template || M.template());
          if (old) {
            const index = updated.findIndex((x) => x.id === old.id);
            if (index < 0)
              throw new Error(
                "This template activity was removed on another device.",
              );
            updated[index] = t;
          } else updated.push(t);
          await saveSettings({ ...settings, template: updated });
        } else {
          const latest = cases.find((record) => record.id === c.id);
          if (!latest)
            throw new Error("This case was removed from the shared workspace.");
          const latestTask = old
            ? latest.tasks.find((task) => task.id === old.id)
            : null;
          if (old && !latestTask)
            throw new Error("This activity was removed on another device.");
          t.done = latestTask ? latestTask.done : false;
          t.dueDate = fd.get("dueDate");
          M.dateDiff(t.dueDate, t.dueDate);
          const copy = structuredClone(latest);
          if (old) copy.tasks[copy.tasks.findIndex((x) => x.id === old.id)] = t;
          else copy.tasks.push(t);
          await saveCase(copy);
        }
        closeModal();
        render();
        toast("Activity saved.");
      },
    );
  }
  async function saveCase(c) {
    c.updatedAt = new Date().toISOString();
    await DB.saveCase(c);
    const i = cases.findIndex((x) => x.id === c.id);
    if (i < 0) cases.push(c);
    else cases[i] = c;
    queueReminderSync();
  }
  async function saveSettings(s) {
    await DB.saveSettings(s);
    settings = s;
  }
  async function api(path, method, body) {
    if (body && body.snapshot && sync.isConnected() && sync.isUnlocked()) {
      body = { ...body, workspaceVersion: sync.getState().version };
    }
    return R.request(path, method, body);
  }
  function snapshot() {
    const active = activeCases().filter((c) => !c.demo);
    return {
      caseCount: active.length,
      caseDueDates: active.map((c) => c.dueDate),
      taskDueDates: active.flatMap((c) =>
        c.tasks.filter((t) => !t.done).map((t) => t.dueDate),
      ),
    };
  }
  function queueReminderSync() {
    if (sync.isConnected() && (!sync.isUnlocked() || sync.isConflicted()))
      return;
    if (workspaceWriteDepth) {
      pendingReminderSync = true;
      return;
    }
    if (!reminder && !R.hasCloud()) return;
    const dates = {
      snapshot: snapshot(),
      ...(sync.isConnected() && sync.isUnlocked()
        ? { workspaceVersion: sync.getState().version }
        : {}),
    };
    syncQueue = syncQueue
      .catch(() => {})
      .then(async () => {
        if (
          workspaceWriteDepth ||
          (sync.isConnected() && (!sync.isUnlocked() || sync.isConflicted()))
        )
          return;
        try {
          reminder = R.usesWorkspace()
            ? await R.request("/api/reminders")
            : await R.request("/api/reminders/snapshot", "PUT", dates);
          reminderError = "";
        } catch (error) {
          reminderError = error.message;
          toast(
            (R.usesWorkspace()
              ? "The workspace is synced. Reminder status could not refresh: "
              : "Saved locally. Reminder dates could not sync: ") +
              error.message,
            true,
          );
        }
      });
  }
  async function backup() {
    const data = await DB.exportBackup();
    download(
      new Blob([JSON.stringify(data)], { type: "application/json" }),
      "weekwise-backup-" + M.today() + ".json",
    );
    if (!sync.isConnected())
      await saveSettings({ ...settings, lastBackup: new Date().toISOString() });
    if (route === "settings") render();
    toast("Backup downloaded, including uploaded evidence.");
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function navigate(next) {
    route = next;
    query = "";
    if (next === "overview") filter = "active";
    if (next === "cases" && filter === "active") filter = "all";
    window.location.hash =
      next === "case" ? "case/" + encodeURIComponent(selectedId) : next;
    render();
    window.scrollTo(0, 0);
  }
  async function loadDemo() {
    if (cases.length)
      throw new Error("Example cases are available in an empty workspace.");
    const examples = M.makeDemo().map((c) => ({ ...c, demo: true }));
    const demonstration = examples.find((c) => c.status === "in_progress");
    const complete = examples.find((c) => c.status === "completed");
    const files = [demonstration, complete].map((record, index) => {
      const id = M.uid(),
        name = index
          ? "Sample submission checklist.txt"
          : "Sample assessment evidence.txt";
      const text =
        "WEEKWISE - FICTIONAL EXAMPLE ONLY\n\nPatient: " +
        record.name +
        "\nThis file demonstrates evidence uploads and downloads.\nIt is not a real patient record or clinical report.\n\n" +
        (index
          ? "Example: report finalized; sections uploaded; paperwork submitted.\n"
          : "Example: teacher materials received; parent interview scheduled; remaining activities tracked in Weekwise.\n") +
        "\nYou can remove this sample safely using Remove examples.\n";
      record.attachments.push({
        id: M.uid(),
        name,
        kind: "file",
        fileId: id,
        size: text.length,
        createdAt: new Date().toISOString(),
      });
      return { id, name, type: "text/plain", data: btoa(text) };
    });
    demonstration.attachments.push({
      id: M.uid(),
      name: "Example local report location",
      kind: "path",
      value:
        "C:\\Example Patient Files\\" +
        demonstration.name +
        "\\Draft report.docx",
      createdAt: new Date().toISOString(),
    });
    demonstration.attachments.push(
      {
        id: M.uid(),
        name: "Example signed paper form",
        kind: "paper",
        value: "Fictional example: office cabinet A, blue assessment folder",
        createdAt: new Date().toISOString(),
      },
      {
        id: M.uid(),
        name: "Google Drive example (opens My Drive)",
        kind: "drive",
        value: "https://drive.google.com/drive/my-drive",
        createdAt: new Date().toISOString(),
      },
    );
    const seedSettings = { ...settings, initialized: true, demo: true };
    // Seed records and evidence together; an interrupted first launch never leaves a partial demo.
    await DB.importBackup({
      format: "weekwise",
      version: 1,
      cases: examples,
      settings: seedSettings,
      files,
    });
    cases = examples;
    settings = seedSettings;
    render();
    toast("Fictional examples loaded.");
  }
  async function clearDemo() {
    for (const c of cases.filter((c) => c.demo)) await DB.deleteCase(c.id);
    cases = cases.filter((c) => !c.demo);
    await saveSettings({ ...settings, demo: false });
    queueReminderSync();
    render();
    toast("Example cases removed. Your own cases are kept.");
  }
  async function uploadFiles(files) {
    const caseId = selectedId;
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) {
        toast(file.name + " exceeds 25 MB.", true);
        continue;
      }
      const fileId = M.uid();
      await DB.putFile({ id: fileId, blob: file });
      try {
        const copy = structuredClone(cases.find((c) => c.id === caseId));
        copy.attachments.push({
          id: M.uid(),
          name: file.name,
          kind: "file",
          fileId,
          size: file.size,
          createdAt: new Date().toISOString(),
        });
        await saveCase(copy);
      } catch (error) {
        await DB.deleteFile(fileId);
        throw error;
      }
    }
    render();
    toast("Evidence saved on this laptop.");
  }
  function referenceModal() {
    showModal(
      "Add a document reference",
      '<div class="field"><label for="reference-name">Document name</label><input id="reference-name" name="name" maxlength="500" required placeholder="e.g. Signed assessment plan"></div><div class="field"><label for="reference-kind">Reference type</label><select id="reference-kind" name="kind"><option value="path">File on this laptop</option><option value="paper">Paper document location</option><option value="drive">Google Drive or Docs</option><option value="link">Other web document link</option></select></div><div class="field"><label for="reference-value">File path or document URL</label><input id="reference-value" name="value" maxlength="4000" required placeholder="File path, paper filing location, or document URL"><p class="form-help">For paper, record where it is filed. Local references save a location, not a copy; use Copy path in File Explorer. Google Drive and Docs links open in your signed-in browser; files are not uploaded here.</p></div>',
      '<button type="submit" class="button primary">Add reference</button>',
      async (fd) => {
        const kind = fd.get("kind"),
          value = fd.get("value").trim();
        if (!value) throw new Error("Enter the document location.");
        if (kind === "link" || kind === "drive") {
          let url;
          try {
            url = new URL(value);
          } catch (_) {
            throw new Error("Enter a full http or https document URL.");
          }
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new Error(
              "Use an http or https link without embedded credentials.",
            );
          if (
            kind === "drive" &&
            (url.protocol !== "https:" ||
              !["docs.google.com", "drive.google.com"].includes(url.hostname))
          ) {
            throw new Error("Use an HTTPS Google Drive or Google Docs URL.");
          }
        }
        const copy = structuredClone(currentCase());
        copy.attachments.push({
          id: M.uid(),
          name: fd.get("name").trim(),
          kind,
          value,
          createdAt: new Date().toISOString(),
        });
        await saveCase(copy);
        closeModal();
        render();
        toast("Document reference added.");
      },
    );
  }
  const actions = {
    navigate: (el) => navigate(el.dataset.route),
    "new-case": () => caseModal(false),
    "edit-case": () => caseModal(true),
    "close-modal": closeModal,
    "open-case": (el) => {
      selectedId = el.dataset.id;
      detailTab = "activities";
      navigate("case");
    },
    metric: (el) => {
      filter = el.dataset.filter;
      route = "cases";
      query = "";
      window.location.hash = "cases";
      render();
    },
    "detail-tab": (el) => {
      detailTab = el.dataset.tab;
      render();
    },
    "add-task": () => taskModal(null, false),
    "edit-task": (el) => taskModal(el.dataset.id, false),
    "delete-task": (el) => {
      const id = el.dataset.id;
      confirmAction(
        "Remove this activity?",
        "The activity and its completion mark will be removed from this case.",
        "Remove activity",
        async () => {
          const c = structuredClone(currentCase());
          c.tasks = c.tasks.filter((t) => t.id !== id);
          await saveCase(c);
          closeModal();
          render();
          toast("Activity removed.");
        },
      );
    },
    "delete-case": () => {
      const c = currentCase();
      confirmAction(
        "Delete " + esc(c.name) + "?",
        "This removes the case, its notes, and all uploaded evidence from this browser. Download a backup first if you need a copy.",
        "Delete case",
        async () => {
          await DB.deleteCase(c.id);
          cases = cases.filter((x) => x.id !== c.id);
          queueReminderSync();
          closeModal();
          navigate("cases");
          toast("Case deleted.");
        },
      );
    },
    "edit-note": (el) => {
      const note = currentCase().notes.find((n) => n.id === el.dataset.id);
      showModal(
        "Edit note",
        '<div class="field"><label for="edit-note-text">Note</label><textarea id="edit-note-text" name="text" maxlength="50000" rows="7" required>' +
          esc(note.text) +
          "</textarea></div>",
        null,
        async (fd) => {
          const text = fd.get("text").trim();
          if (!text) throw new Error("Write a note before saving.");
          const c = structuredClone(currentCase());
          c.notes.find((n) => n.id === note.id).text = text;
          await saveCase(c);
          closeModal();
          render();
          toast("Note updated.");
        },
      );
    },
    "delete-note": (el) => {
      const id = el.dataset.id;
      confirmAction(
        "Delete this note?",
        "This note will be removed from the case.",
        "Delete note",
        async () => {
          const c = structuredClone(currentCase());
          c.notes = c.notes.filter((n) => n.id !== id);
          await saveCase(c);
          closeModal();
          render();
        },
      );
    },
    upload: () => document.getElementById("evidence-files").click(),
    "add-reference": referenceModal,
    "download-file": async (el) => {
      const a = currentCase().attachments.find((a) => a.id === el.dataset.id),
        blob = await DB.getFile(a.fileId);
      if (!blob)
        throw new Error(
          "The saved file could not be found. Restore it from a backup.",
        );
      download(blob, a.name);
    },
    "open-link": (el) => {
      const a = currentCase().attachments.find((a) => a.id === el.dataset.id);
      const u = new URL(a.value);
      if (["https:", "http:"].includes(u.protocol))
        window.open(u.href, "_blank", "noopener,noreferrer");
    },
    "copy-path": async (el) => {
      const a = currentCase().attachments.find((a) => a.id === el.dataset.id);
      try {
        await navigator.clipboard.writeText(a.value);
        toast(
          a.kind === "paper"
            ? "Paper document location copied."
            : "Path copied. Paste it into File Explorer.",
        );
      } catch (_) {
        showModal(
          "Document location",
          '<div class="field"><label for="copy-location">' +
            (a.kind === "paper"
              ? "Paper document location"
              : "Copy this path into File Explorer") +
            '</label><input id="copy-location" readonly value="' +
            esc(a.value) +
            '"></div>',
          button("close-modal", "Done", "primary"),
          async () => closeModal(),
          false,
          false,
        );
      }
    },
    "delete-attachment": (el) => {
      const id = el.dataset.id;
      confirmAction(
        "Remove this evidence?",
        "This removes the saved copy or reference from the case. The original document is kept.",
        "Remove evidence",
        async () => {
          const c = structuredClone(currentCase()),
            a = c.attachments.find((a) => a.id === id);
          c.attachments = c.attachments.filter((a) => a.id !== id);
          await saveCase(c);
          if (a.kind === "file") await DB.deleteFile(a.fileId);
          closeModal();
          render();
          toast("Evidence removed.");
        },
      );
    },
    "template-add": (el) => taskModal(null, true, Number(el.dataset.week) || 1),
    "template-edit": (el) => taskModal(el.dataset.id, true),
    "template-delete": (el) => {
      const id = el.dataset.id;
      confirmAction(
        "Remove template activity?",
        "New cases will no longer include this activity. Existing cases keep their own plans.",
        "Remove activity",
        async () => {
          await saveSettings({
            ...settings,
            template: (settings.template || M.template()).filter(
              (t) => t.id !== id,
            ),
          });
          closeModal();
          render();
        },
      );
    },
    "reset-template": () =>
      confirmAction(
        "Restore original template?",
        "Replace the activity template with the original 19 activities. Existing cases keep their own plans.",
        "Restore template",
        async () => {
          await saveSettings({ ...settings, template: M.template() });
          closeModal();
          render();
        },
      ),
    backup: backup,
    restore: () => document.getElementById("restore-file").click(),
    "connect-cloud": connectCloudModal,
    "connect-workspace": () => workspaceModal(false),
    "unlock-workspace": () => workspaceModal(true),
    "refresh-workspace": refreshSharedWorkspace,
    "lock-workspace": async () => {
      await sync.lock();
      render();
    },
    "google-workspace": async () => {
      const connection = sync.getConnection();
      await sync.setToken(await window.WWGoogle.signIn(connection.clientId));
      await refreshSharedWorkspace();
    },
    "disconnect-workspace": () =>
      confirmAction(
        "Disconnect this browser?",
        "The local copy stays on this device and becomes a local workspace. Cloud records are kept. A separate cloud reminder schedule is unchanged.",
        "Disconnect browser",
        async () => {
          await sync.disconnect();
          await reloadWorkspace();
          reminder = null;
          if (R.hasCloud() || R.canUseLocal()) {
            try {
              reminder = await api("/api/reminders");
              reminderError = "";
            } catch (error) {
              reminderError = error.message;
            }
          }
          closeModal();
          render();
          toast("This browser is disconnected. The local copy is kept.");
        },
        false,
      ),
    "retry-reminders": refreshReminders,
    "disconnect-cloud": () =>
      confirmAction(
        "Disconnect cloud reminders?",
        "This first disables the cloud schedule, then removes the connection token from this browser. Cases and evidence stay here.",
        "Disconnect service",
        async () => {
          await pauseReminders();
          R.clear();
          reminder = null;
          reminderError = "";
          if (R.canUseLocal()) {
            try {
              reminder = await api("/api/reminders");
              if (reminder.config.enabled)
                reminder = await api("/api/reminders", "PUT", {
                  config: { ...reminder.config, enabled: false },
                  snapshot: snapshot(),
                });
            } catch (_) {
              reminder = null;
            }
          }
          closeModal();
          render();
          toast(
            "Cloud schedule paused and connection removed from this browser.",
          );
        },
        false,
      ),
    "load-demo": loadDemo,
    "clear-demo": () =>
      confirmAction(
        "Remove example cases?",
        "Only the fictional example cases will be removed. Cases you added are kept.",
        "Remove examples",
        async () => {
          await clearDemo();
          closeModal();
        },
      ),
    "clear-all": () =>
      confirmAction(
        "Clear this workspace?",
        sync.isConnected()
          ? "All shared cases, notes, uploaded copies, and custom template settings will be removed from the cloud workspace and every connected device when it refreshes. Download a backup first. Connected reminders must be paused before clearing."
          : "All cases, notes, uploaded copies, and custom template settings will be permanently removed from this browser. Download a backup first. Connected reminders must be paused before clearing.",
        "Clear everything",
        async () => {
          await pauseReminders();
          await DB.clearAll();
          cases = [];
          await saveSettings({ initialized: true, demo: false });
          closeModal();
          navigate("overview");
          toast("Workspace cleared.");
        },
      ),
    print: () => window.print(),
    "test-reminder": () => {
      if (!reminder)
        throw new Error(
          R.hasCloud()
            ? "Retry the cloud connection before sending a test."
            : "Connect a reminder service first.",
        );
      if (!reminder.config.channels.length)
        throw new Error("Choose a delivery channel and save reminders first.");
      confirmAction(
        "Send a test reminder?",
        "A generic test will be sent now to the recipient and channels in your saved reminder settings. No patient information is included.",
        "Send test",
        async () => {
          const result = await api("/api/reminders/test", "POST", {});
          reminder = result.status || reminder;
          closeModal();
          render();
          toast("Test accepted by the provider. Check the receiving device.");
        },
        false,
      );
    },
  };

  async function perform(action, el) {
    if (busy) return;
    const fn = actions[action];
    if (!fn) return;
    busy = true;
    try {
      await serialize(async () => {
        const independent = [
          "close-modal",
          "unlock-workspace",
          "connect-workspace",
          "disconnect-workspace",
          "refresh-workspace",
          "lock-workspace",
          "google-workspace",
        ];
        const cachedReads = [
          "navigate",
          "open-case",
          "metric",
          "detail-tab",
          "print",
          "copy-path",
          "download-file",
          "open-link",
          "backup",
          "restore",
        ];
        if (!independent.includes(action) && action !== "backup") {
          try {
            await refreshWorkspace();
          } catch (error) {
            if (error.code === "AUTH") {
              await sync.lock();
              render();
              throw error;
            }
            if (
              !cachedReads.includes(action) ||
              !["OFFLINE", "SERVER", "CONFLICT"].includes(error.code)
            )
              throw error;
            await reloadWorkspace();
          }
        }
        if (action === "load-demo") return withWorkspaceWrite(() => fn(el));
        return fn(el);
      });
    } catch (error) {
      toast(error.message || "Something went wrong.", true);
    } finally {
      busy = false;
    }
  }
  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    if (el) {
      event.preventDefault();
      perform(el.dataset.action, el);
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.id === "case-search") {
      query = event.target.value;
      document.getElementById("case-results").innerHTML = listContent();
    }
    if (["final-due", "case-opened"].includes(event.target.id))
      updateSchedulePreview();
  });
  document.addEventListener("change", (event) => {
    serialize(() => {
      const el = event.target;
      const confirmingCompletion =
        el.id === "case-status" &&
        el.value === "completed" &&
        currentCase().tasks.some((task) => !task.done);
      return el.dataset.taskCheck ||
        (["case-status", "evidence-files"].includes(el.id) &&
          !confirmingCompletion)
        ? withWorkspaceWrite(() => handleChange(event))
        : handleChange(event);
    }).catch((error) => {
      render();
      toast(error.message, true);
    });
  });
  async function handleChange(event) {
    const el = event.target;
    if (el.id === "workspace-auth") {
      const google = el.value === "google";
      document.getElementById("workspace-key-field").hidden = google;
      document.getElementById("workspace-google-field").hidden = !google;
      document.getElementById("workspace-key").required = !google;
      document.getElementById("workspace-client-id").required = google;
      return;
    }
    if (el.id === "case-filter") {
      filter = el.value;
      render();
      return;
    }
    if (el.id === "activity-week" && modal.querySelector("[name=dueDate]")) {
      const c = currentCase();
      modal.querySelector("[name=dueDate]").value = M.taskDue(
        c.startDate,
        c.dueDate,
        Number(el.value),
      );
      return;
    }
    if (el.id === "evidence-files") {
      try {
        await uploadFiles(Array.from(el.files));
      } catch (error) {
        throw error;
      }
      return;
    }
    if (el.id === "restore-file") {
      const file = el.files[0];
      el.value = "";
      if (!file) return;
      try {
        if (file.size > 140 * 1024 * 1024)
          throw new Error("Choose a backup smaller than 140 MB.");
        const data = JSON.parse(await file.text());
        DB.validateBackup(data);
        confirmAction(
          "Replace workspace from backup?",
          "Restore <strong>" +
            data.cases.length +
            " cases</strong> and " +
            data.files.length +
            " uploaded files. " +
            (sync.isConnected()
              ? "This replaces the shared workspace for every connected device when it refreshes. "
              : "This replaces the current workspace. ") +
            "Reminder connections stay separate and must be paused before restore.",
          "Restore backup",
          async () => {
            await pauseReminders();
            await DB.importBackup(data);
            cases = await DB.getCases();
            settings = await DB.getSettings();
            await saveSettings({ ...settings, initialized: true });
            queueReminderSync();
            closeModal();
            navigate("overview");
            toast("Backup restored, including uploaded evidence.");
          },
        );
      } catch (error) {
        toast(
          error.message === "Unexpected token"
            ? "Choose a valid Weekwise backup."
            : error.message,
          true,
        );
      }
      return;
    }
    if (el.id === "case-status") {
      try {
        const c = structuredClone(currentCase());
        if (el.value === "completed" && c.tasks.some((t) => !t.done)) {
          const target = el.value;
          render();
          confirmAction(
            "Complete this case?",
            "Some activities are still unchecked. Completing the case removes it from deadline reminders. You can reopen it later.",
            "Complete case",
            async () => {
              const latest = structuredClone(currentCase());
              latest.status = target;
              await saveCase(latest);
              closeModal();
              render();
              toast("Case completed.");
            },
          );
          return;
        }
        c.status = el.value;
        await saveCase(c);
        render();
        toast(c.status === "completed" ? "Case completed." : "Status updated.");
      } catch (error) {
        throw error;
      }
      return;
    }
    if (el.dataset.taskCheck) {
      el.disabled = true;
      try {
        const c = structuredClone(currentCase()),
          t = c.tasks.find((t) => t.id === el.dataset.taskCheck);
        t.done = el.checked;
        if (t.done && c.status === "open") c.status = "in_progress";
        await saveCase(c);
        render();
        if (c.tasks.every((t) => t.done) && c.status !== "completed")
          toast(
            "All activities checked off. Set the case status to Completed when it is ready.",
          );
      } catch (error) {
        throw error;
      }
    }
  }
  document.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const form = event.target;
    const noteDraft =
      form.id === "note-form"
        ? form.querySelector('[name="text"]').value
        : null;
    busy = true;
    const submit = form.querySelector("[type=submit]");
    if (submit) submit.disabled = true;
    try {
      await serialize(async () => {
        const writeWorkspace =
          form.id === "note-form" ||
          (form.id === "modal-form" && modalWorkspaceWrite);
        const work = async () => {
          if (
            form.id === "modal-form" &&
            modalWorkspaceWrite &&
            modalWorkspaceVersion !== null &&
            sync.getState().version !== modalWorkspaceVersion
          ) {
            throw new Error(
              "This workspace changed on another device. Close this editor and reopen it before saving.",
            );
          }
          const fd = new FormData(form);
          if (form.id === "modal-form" && modalAction) {
            await modalAction(fd);
          } else if (form.id === "note-form") {
            const text = fd.get("text").trim();
            if (!text) throw new Error("Write a note before adding it.");
            const c = structuredClone(currentCase());
            c.notes.push({
              id: M.uid(),
              text,
              createdAt: new Date().toISOString(),
            });
            await saveCase(c);
            render();
            toast("Note added.");
          } else if (form.id === "reminder-form") {
            const config = {
              enabled: fd.has("enabled"),
              channels: [
                ...(fd.has("channelEmail") ? ["email"] : []),
                ...(fd.has("channelSms") ? ["sms"] : []),
              ],
              email: fd.get("email").trim(),
              phone: fd.get("phone").trim(),
              daysAhead: Number(fd.get("daysAhead")),
              time: fd.get("time"),
              includeOverdue: fd.has("includeOverdue"),
            };
            await syncQueue.catch(() => {});
            reminder = await api("/api/reminders", "PUT", {
              config,
              snapshot: snapshot(),
            });
            render();
            toast(
              config.enabled
                ? "Daily reminders enabled."
                : "Reminder preferences saved.",
            );
          }
        };
        if (writeWorkspace) await withWorkspaceWrite(work);
        else {
          if (form.id === "reminder-form") await refreshWorkspace();
          await work();
        }
      });
    } catch (error) {
      if (noteDraft !== null && document.getElementById("note-text"))
        document.getElementById("note-text").value = noteDraft;
      const target =
        form.id === "modal-form"
          ? modal.querySelector("#modal-error")
          : form.id === "reminder-form"
            ? document.getElementById("reminder-error")
            : null;
      if (target && (form.id !== "modal-form" || modal.open)) {
        target.textContent = error.message;
        target.hidden = false;
      } else toast(error.message, true);
    } finally {
      busy = false;
      if (submit && submit.isConnected) submit.disabled = false;
    }
  });
  modal.addEventListener("cancel", () => {
    modal.querySelectorAll('input[type="password"]').forEach((input) => {
      input.value = "";
    });
    modalAction = null;
  });
  window.addEventListener("hashchange", () => {
    readRoute();
    render();
  });
  function readRoute() {
    let hash;
    try {
      hash = decodeURIComponent(window.location.hash.slice(1));
    } catch (_) {
      hash = "overview";
    }
    if (hash.startsWith("case/")) {
      selectedId = hash.slice(5);
      route = "case";
    } else if (
      ["overview", "cases", "upcoming", "templates", "settings"].includes(hash)
    )
      route = hash;
    else route = "overview";
  }
  async function init() {
    try {
      await DB.init();
      [cases, settings] = await Promise.all([DB.getCases(), DB.getSettings()]);
      if (!settings.initialized && !sync.isConnected()) {
        if (!cases.length) await loadDemo();
        else await saveSettings({ ...settings, initialized: true });
      }
      readRoute();
      render();
      if (
        (R.hasCloud() || R.canUseLocal()) &&
        !(sync.isConnected() && !sync.isUnlocked())
      ) {
        try {
          reminder = await api("/api/reminders");
          reminderError = "";
          queueReminderSync();
        } catch (error) {
          reminderError = R.hasCloud() ? error.message : "";
        }
        if (route === "settings") render();
      }
      if (navigator.storage && navigator.storage.persist)
        navigator.storage.persist().catch(() => {});
    } catch (error) {
      app.innerHTML =
        '<main class="loading-screen"><h1>We couldn’t open your workspace.</h1><p>' +
        esc(error.message) +
        "</p><p>Use a regular browser window with local storage enabled, then reload.</p></main>";
    }
  }
  if (navigator.locks) {
    navigator.locks
      .request(
        "weekwise-workspace-writer",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            app.innerHTML =
              '<main class="loading-screen"><div class="brand-mark">' +
              icon("folder") +
              '</div><h1>Your workspace is already open.</h1><p>Keep one Weekwise tab open so every change stays in sync. Close the other tab, then reload this one.</p><button class="button primary" id="retry-workspace">Try again</button></main>';
            document.getElementById("retry-workspace").onclick = () =>
              window.location.reload();
            return;
          }
          await init();
          await new Promise(() => {});
        },
      )
      .catch((error) => {
        toast(error.message, true);
      });
  } else
    app.innerHTML =
      '<main class="loading-screen"><h1>This browser can’t safely open the workspace.</h1><p>Open Weekwise in an updated Chrome, Edge, or Firefox browser at its local address.</p></main>';
})();

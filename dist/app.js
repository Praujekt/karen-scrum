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
    selectedId = null,
    selectedTemplateId = null,
    overviewSelectedDate = null;
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
    open: "Not Started",
    in_progress: "In Progress",
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
    return new Date(value + "T12:00:00Z").toLocaleDateString(
      undefined,
      full
        ? { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }
        : { month: "short", day: "numeric", timeZone: "UTC" },
    );
  }
  function stamp(value) {
    return new Date(value).toLocaleString(undefined, {
      timeZone: M.TIME_ZONE,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
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
        ? "Due Today"
        : days === 1
          ? "Due Tomorrow"
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
          " <strong>Example Workspace</strong> · All patient names and records are fictional.</span>" +
          '<div class="header-actions">' +
          button("refresh-demo", "Refresh Examples", "ghost small") +
          button("clear-demo", "Remove Examples", "ghost small") +
          "</div>" +
          "</div>"
      : "";
  }
  function nav(id, name, ic, count, active = route === id) {
    return (
      '<button class="nav-item ' +
      (active ? "active" : "") +
      '" data-action="navigate" data-route="' +
      id +
      '" ' +
      (active ? 'aria-current="page"' : "") +
      ">" +
      icon(ic) +
      "<span>" +
      name +
      "</span>" +
      (count == null ? "" : '<span class="nav-count">' + count + "</span>") +
      "</button>"
    );
  }
  const caseFolderFilters = [
    ["open", "Not Started"],
    ["in_progress", "In Progress"],
    ["completed", "Completed"],
  ];
  const caseFilterPaths = {
    all: "cases",
    active: "cases/active",
    due: "cases/due",
    open: "cases/not-started",
    in_progress: "cases/in-progress",
    completed: "cases/completed",
  };
  function caseFolders() {
    const childSelected =
      route === "cases" &&
      caseFolderFilters.some(([value]) => value === filter);
    return (
      '<div class="nav-case-folder">' +
      nav(
        "cases",
        "All Cases",
        "folder",
        cases.length,
        route === "cases" && !childSelected,
      ) +
      '<div class="nav-subgroup" role="group" aria-label="Case Status Folders">' +
      caseFolderFilters
        .map(([value, label]) => {
          const active = route === "cases" && filter === value;
          return (
            '<button type="button" class="nav-item nav-subitem ' +
            value.replace("_", "-") +
            (active ? " active" : "") +
            '" data-action="case-status-filter" data-filter="' +
            value +
            '"' +
            (active ? ' aria-current="page"' : "") +
            '><span class="folder-status-dot" aria-hidden="true"></span><span>' +
            label +
            '</span><span class="nav-count">' +
            cases.filter((c) => c.status === value).length +
            "</span></button>"
          );
        })
        .join("") +
      "</div></div>"
    );
  }
  function render() {
    if (workspaceWriteDepth) return;
    if (sync.isConnected() && !sync.isUnlocked()) {
      app.innerHTML =
        '<main class="loading-screen workspace-locked"><div class="brand-mark">' +
        icon("shield") +
        '</div><p class="eyebrow">Karen’s Load · Shared Workspace</p><h1>Unlock Your Workspace</h1>' +
        "<p>Sign in and enter your encryption passphrase to open the records on this device.</p>" +
        '<p class="form-help">Your passphrase is never saved. This browser’s case view stays hidden until unlocked.</p>' +
        '<div class="form-actions">' +
        button("unlock-workspace", "Unlock Shared Workspace", "primary") +
        button("disconnect-workspace", "Disconnect This Browser", "secondary") +
        "</div></main>";
      return;
    }
    if (route === "case" && !cases.some((c) => c.id === selectedId))
      route = "overview";
    const titles = {
      overview: "Overview",
      cases: "All Cases",
      upcoming: "Coming Up",
      templates: "Activity Templates",
      settings: "Reminders & Settings",
      case: "Case Details",
    };
    app.innerHTML =
      '<div class="app-shell"><aside class="sidebar"><a href="#overview" class="brand" aria-label="Karen’s Load Overview"><span class="brand-mark">' +
      icon("calendar") +
      '</span><span class="brand-name">Karen’s <span class="brand-subname">Load<span class="brand-period">.</span></span></span></a><p class="workspace-label">Your Workspace</p><nav class="nav-group" aria-label="Main Navigation">' +
      nav("overview", "Overview", "grid") +
      caseFolders() +
      nav("upcoming", "Coming Up", "calendar") +
      '</nav><div class="nav-divider"></div><p class="workspace-label">Make It Yours</p><nav class="nav-group" aria-label="Workspace Settings">' +
      nav("templates", "Activity Templates", "file") +
      nav("settings", "Reminders & Settings", "bell") +
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
      ' Local Workspace</span><span class="today-date">' +
      new Date().toLocaleDateString(undefined, {
        timeZone: M.TIME_ZONE,
        weekday: "short",
        month: "short",
        day: "numeric",
      }) +
      '</span><span class="profile-avatar" aria-label="Personal Workspace">K</span></div></div>' +
      workspaceBanner() +
      demoBanner() +
      (route === "overview"
        ? window.KLOverview.render({
            cases,
            throughDate: overviewSelectedDate || M.addDays(M.today(), 7),
            today: M.today(),
            model: M,
            esc,
            icon,
            fmt,
            dueText,
            button,
          })
        : route === "cases"
          ? dashboard()
          : route === "case"
            ? detail()
            : route === "upcoming"
              ? upcoming()
              : route === "templates"
                ? templates()
                : settingsPage()) +
      '<footer class="page-footer"><span>Made for a little more peace of mind.</span><span>Karen’s Load · Personal Workspace</span></footer></main></div>';
  }
  function stats() {
    const active = activeCases(),
      late = active.filter((c) => c.dueDate < M.today()).length;
    const values = [
      [
        "folder",
        "Open Cases",
        active.length,
        active.filter((c) => c.status === "in_progress").length +
          " currently in progress",
        "active",
      ],
      [
        "calendar",
        "Cases Due Soon",
        active.filter((c) => M.dateDiff(M.today(), c.dueDate) <= 7).length,
        "Next 7 days" +
          (late ? " · " + late + " overdue" : " · including today"),
        "due",
      ],
      [
        "clock",
        "Not Started Cases",
        active.filter((c) => c.status === "open").length,
        "Ready to get started",
        "open",
      ],
      [
        "circle",
        "Total Completed",
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
      ["active", "All Active"],
      ["open", "Not Started"],
      ["in_progress", "In Progress"],
      ["completed", "Completed"],
      ["all", "All Cases"],
    ];
    return (
      '<div class="toolbar"><label class="search-field">' +
      icon("search") +
      '<span class="sr-only">Search Patients</span><input type="search" id="case-search" placeholder="Search patients…" value="' +
      esc(query) +
      '"></label><label class="sr-only" for="case-filter">Filter Cases</label><select id="case-filter" class="filter-select">' +
      (filter === "due"
        ? '<option value="due" selected>Due Soon & Overdue</option>'
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
      '<button class="case-card ' +
      (c.status !== "completed"
        ? c.dueDate < M.today()
          ? "case-overdue"
          : M.dateDiff(M.today(), c.dueDate) <= 7
            ? "case-due-soon"
            : ""
        : "") +
      '" data-action="open-case" data-id="' +
      esc(c.id) +
      '"><span class="case-main"><span class="avatar avatar-' +
      (index % 4) +
      '">' +
      esc(initials(c.name)) +
      '</span><span class="case-info"><span class="case-name">' +
      esc(c.name) +
      '</span><span class="case-meta">' +
      (c.status === "completed"
        ? "Case Completed"
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
      (c.status === "completed" ? "Final Deadline" : dueText(c.dueDate)) +
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
            ? "No Cases in This View"
            : "A Clearer Caseload Starts Here",
          cases.length
            ? "Try another filter or patient name."
            : "Add your first patient to turn a final due date into a clear, five-week plan.",
          cases.length
            ? ""
            : button(
                "new-case",
                icon("plus") + " Add Your First Case",
                "primary",
              ) +
                '<div class="empty-demo">' +
                button("load-demo", "Try Example Cases", "ghost") +
                "</div>",
        );
  }
  function dashboard() {
    const isOverview = route === "overview";
    return (
      header(
        isOverview ? "A Little Clarity, Every Day" : "Your Caseload",
        isOverview ? "Your Work, at a Glance." : "A Place for Every Case.",
        "Keep the next step in sight, and the bigger picture in balance.",
        button("new-case", icon("plus") + " New Case", "primary"),
      ) +
      stats() +
      '<div class="dashboard-grid"><section class="content-column"><div class="section-heading"><h2>' +
      (isOverview ? "Your Open Cases" : "All Cases") +
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
      '<section class="panel workload-panel"><div class="section-heading"><h2>The Weekly Picture</h2>' +
      icon("leaf") +
      '</div><p class="muted small">Unfinished activities by due week</p><div class="week-strip">' +
      [1, 2, 3, 4, 5]
        .map((w) => {
          const total = activeCases()
              .flatMap((c) => c.tasks)
              .filter((t) => M.activityEndWeek(t) === w).length,
            n = activeCases()
              .flatMap((c) => c.tasks)
              .filter((t) => M.activityEndWeek(t) === w && !t.done).length;
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
      "</span><h3>A Workspace That Stays with You.</h3><p>Cases and evidence are saved in this browser on this laptop. Download a backup to keep a separate copy.</p>" +
      button("backup", "Download Backup " + icon("arrow"), "ghost small") +
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
      '<section class="panel agenda-panel"><div class="section-heading"><h2>Needs a Little Attention</h2><span class="agenda-bell">' +
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
        "View Upcoming Work " + icon("arrow"),
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
        icon("back") + " All Cases",
        "ghost small",
        'data-route="cases"',
      ) +
      "</div>" +
      header(
        "Patient Case",
        esc(c.name),
        "Opened " +
          fmt(c.startDate) +
          ' <span class="dot-divider">·</span> Final deadline ' +
          fmt(c.dueDate, true),
        button("edit-case", icon("edit") + " Edit Case", "secondary") +
          button("print", icon("file") + " Print Plan", "secondary"),
      ) +
      '<div class="detail-grid"><section><div class="panel timeline-summary"><div class="section-heading"><h2>The Path to Completion</h2><strong>' +
      p.percent +
      "%</strong></div>" +
      progress(c) +
      '<div class="timeline-weeks">' +
      [1, 2, 3, 4, 5]
        .map((w) => {
          const ts = c.tasks.filter((t) => M.activityEndWeek(t) === w),
            done = ts.filter((t) => t.done).length;
          return (
            '<div class="timeline-week ' +
            (done === ts.length && ts.length ? "done" : "") +
            '"><span>Week ' +
            w +
            "</span><strong>" +
            fmt(M.taskDue(c.startDate, c.dueDate, w)) +
            "</strong><small>" +
            (ts.length ? done + "/" + ts.length + " Complete" : "Nothing Due") +
            "</small></div>"
          );
        })
        .join("") +
      '</div><p class="form-help">Weekly target dates work backward from ' +
      fmt(c.dueDate) +
      '. Each activity date can be changed. Week totals count activities ending that week.</p></div><div class="detail-tabs tabs" role="tablist" aria-label="Case Information">' +
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
      '</div></section><aside class="detail-sidebar"><section class="panel"><div class="section-heading"><h2>Case Overview</h2>' +
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
            l +
            "</option>",
        )
        .join("") +
      '</select></div><dl class="info-grid"><div class="info-item"><dt>Final Due Date</dt><dd>' +
      fmt(c.dueDate, true) +
      '</dd></div><div class="info-item"><dt>Time Remaining</dt><dd class="' +
      (c.status === "completed" ? "" : dueClass(c.dueDate)) +
      '">' +
      (c.status === "completed" ? "Case Completed" : dueText(c.dueDate)) +
      '</dd></div><div class="info-item"><dt>Planned Start</dt><dd>' +
      fmt(M.addDays(c.dueDate, -34)) +
      '</dd></div><div class="info-item"><dt>Activities Complete</dt><dd>' +
      p.done +
      " of " +
      p.total +
      '</dd></div><div class="info-item"><dt>Template</dt><dd>' +
      esc(c.sourceTemplateName || "Default") +
      "</dd></div></dl>" +
      (c.startDate > M.addDays(c.dueDate, -34)
        ? '<div class="notice"><span>This case opened after the five-week plan starts. Review early activity dates for a shorter timeline.</span></div>'
        : "") +
      '</section><section class="tip-card"><h3>Every Case Has Its Own Pace.</h3><p>Add or remove activities and edit their dates to fit this patient. Remove any If Needed activities that do not apply.</p>' +
      button("add-task", icon("plus") + " Add Activity", "secondary small") +
      '</section><div class="case-updated">Last updated ' +
      stamp(c.updatedAt) +
      "</div>" +
      button(
        "delete-case",
        icon("trash") + " Delete Case",
        "ghost small danger",
      ) +
      "</aside></div>"
    );
  }
  function activityEndpoint(task, week) {
    return M.activitySpansWeeks(task)
      ? task.week === week
        ? "start"
        : "end"
      : "single";
  }
  function activityTitle(task, endpoint) {
    return (
      esc(task.title) +
      (endpoint === "start" ? " (Start)" : endpoint === "end" ? " (End)" : "")
    );
  }
  function ifNeededTag(task) {
    return task.optional
      ? '<span class="optional-tag" title="Conditional activity: complete it if it applies, or remove it from this case.">If Needed</span>'
      : "";
  }
  function taskRow(c, task, endpoint) {
    const isStart = endpoint === "start";
    const urgency =
      !isStart && !task.done && c.status !== "completed"
        ? task.dueDate < M.today()
          ? "urgent-overdue"
          : M.dateDiff(M.today(), task.dueDate) <= 7
            ? "urgent-soon"
            : ""
        : "";
    const title =
      '<span class="task-title">' +
      activityTitle(task, endpoint) +
      ifNeededTag(task) +
      "</span>";
    const stages = isStart
      ? '<div class="task-start-entry"><span class="task-start-marker" aria-hidden="true">' +
        icon(task.done ? "check" : "arrow") +
        '</span><div class="task-description">' +
        title +
        '<span class="task-endpoint-help">' +
        (task.done
          ? "Activity completed."
          : M.isAwaitingSubmission(task)
            ? "Written; mark Submitted at the End entry in Week " +
              M.activityEndWeek(task) +
              "."
            : "Complete at the End entry in Week " +
              M.activityEndWeek(task) +
              ".") +
        "</span></div></div>"
      : task.requiresSubmission
        ? '<div class="task-description">' +
          title +
          '<div class="task-stage-checks"><label><input type="checkbox" data-task-written="' +
          esc(task.id) +
          '" aria-label="Mark ' +
          esc(task.title) +
          ' Written"' +
          (task.written || task.done ? " checked" : "") +
          '> Written</label><label><input type="checkbox" data-task-check="' +
          esc(task.id) +
          '" aria-label="Mark ' +
          esc(task.title) +
          ' Submitted"' +
          (task.done ? " checked" : "") +
          "> Submitted</label></div></div>"
        : '<label class="task-check"><input type="checkbox" data-task-check="' +
          esc(task.id) +
          '"' +
          (task.done ? " checked" : "") +
          ' aria-label="Complete ' +
          esc(task.title) +
          '">' +
          title +
          "</label>";
    const dates = isStart
      ? "Starts " + fmt(M.activityStartDate(c, task))
      : (endpoint === "end" ? "Due " : "") + fmt(task.dueDate);
    return (
      '<div class="task-row ' +
      (task.done ? "is-done " : "") +
      urgency +
      (isStart
        ? " task-row--start"
        : task.requiresSubmission
          ? " task-row--staged"
          : "") +
      '" data-task-id="' +
      esc(task.id) +
      '" data-endpoint="' +
      endpoint +
      '">' +
      stages +
      '<div class="task-meta"><span>' +
      dates +
      "</span>" +
      (urgency
        ? '<strong class="activity-due-label">' +
          (urgency === "urgent-overdue"
            ? dueText(task.dueDate)
            : task.dueDate === M.today()
              ? "Due Today"
              : dueText(task.dueDate)) +
          "</strong>"
        : "") +
      '</div><div class="task-actions"><button class="icon-button" data-action="edit-task" data-id="' +
      esc(task.id) +
      '" aria-label="Edit ' +
      esc(task.title) +
      '">' +
      icon("edit") +
      "</button></div></div>"
    );
  }
  function tasksView(c) {
    return (
      '<div class="section-heading activities-heading"><div class="activities-guidance"><p class="muted small">Check off each activity as it is finished. Multi-week activities are completed at their End entry.</p>' +
      (c.tasks.some((task) => task.optional)
        ? '<p class="form-help"><strong>If Needed</strong> means a conditional activity. It still counts toward progress and due lists. If it does not apply, use Edit Activity to remove it from this case.</p>'
        : "") +
      "</div>" +
      button("add-task", icon("plus") + " Add Activity", "secondary small") +
      "</div>" +
      [1, 2, 3, 4, 5]
        .map((w) => {
          const tasks = c.tasks
            .filter((t) => t.week === w || M.activityEndWeek(t) === w)
            .sort((a, b) => {
              const date = (task) =>
                activityEndpoint(task, w) === "start"
                  ? M.activityStartDate(c, task)
                  : task.dueDate;
              return (
                date(a).localeCompare(date(b)) || a.title.localeCompare(b.title)
              );
            });
          const finishing = tasks.filter(
            (task) => M.activityEndWeek(task) === w,
          );
          const starting = tasks.filter(
            (task) => activityEndpoint(task, w) === "start",
          );
          return (
            '<section class="task-week"><div class="week-heading"><span class="week-pill">' +
            String(w).padStart(2, "0") +
            "</span><h2>Week " +
            w +
            '</h2><span class="week-range">' +
            fmt(M.addDays(c.dueDate, -34 + (w - 1) * 7)) +
            " – " +
            fmt(M.taskDue(c.startDate, c.dueDate, w)) +
            '</span><span class="week-workload">' +
            (starting.length
              ? '<span class="week-starting">' +
                starting.length +
                " Starting</span>"
              : "") +
            '<span class="week-done">' +
            (finishing.length
              ? finishing.filter((t) => t.done).length +
                "/" +
                finishing.length +
                " Complete"
              : "No Activities Due") +
            "</span></span></div>" +
            (tasks.length
              ? tasks
                  .map((task) => taskRow(c, task, activityEndpoint(task, w)))
                  .join("")
              : '<p class="empty-week">No activities start or finish this week.</p>') +
            "</section>"
          );
        })
        .join("")
    );
  }
  function notesView(c) {
    return (
      '<section class="panel"><form id="note-form"><div class="field"><label for="note-text">Add a Case Note</label><textarea id="note-text" name="text" rows="4" maxlength="50000" placeholder="Updates, conversations, or something to remember…" required></textarea></div><div class="form-actions"><button class="button primary" type="submit">' +
      icon("plus") +
      ' Add Note</button></div></form></section><div class="note-list">' +
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
                '" aria-label="Edit Note">' +
                icon("edit") +
                '</button><button class="icon-button danger" data-action="delete-note" data-id="' +
                esc(n.id) +
                '" aria-label="Delete Note">' +
                icon("trash") +
                '</button></div></div><p class="note-text">' +
                esc(n.text) +
                "</p></article>",
            )
            .join("")
        : empty(
            "A Place for the Details",
            "Keep useful updates and context together with this case.",
          )) +
      "</div>"
    );
  }
  function evidenceView(c) {
    return (
      '<section class="panel"><div class="section-heading"><div><h2>Keep the Evidence Together</h2><p class="form-help">Upload a copy or save a reference to an existing document.</p></div></div><div class="evidence-actions">' +
      button("upload", icon("upload") + " Upload Files", "primary") +
      button(
        "add-reference",
        icon("link") + " Add Document Reference",
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
                        ? " Copy Path"
                        : a.kind === "paper"
                          ? " Copy Location"
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
            "The Supporting Details, in One Place",
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
        "One Step at a Time",
        "What’s Coming Up.",
        "Overdue activities and everything due in the next 7 days.",
        button("new-case", icon("plus") + " New Case", "primary"),
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
                      (M.activitySpansWeeks(t)
                        ? " · Due Week " + M.activityEndWeek(t)
                        : " · Week " + t.week) +
                      "</span></span>" +
                      icon("arrow") +
                      "</button>",
                  )
                  .join("") +
                "</section>",
            )
            .join("")
        : empty(
            "You’re Clear for the Week",
            "No unfinished activities are due in the next 7 days. Review your cases to see the rest of the plan.",
            button("navigate", "View Cases", "secondary", 'data-route="cases"'),
          ))
    );
  }
  function templateLibrary() {
    return M.getTemplates(settings);
  }
  function selectedTemplate() {
    const library = templateLibrary();
    const chosen =
      library.find((entry) => entry.id === selectedTemplateId) ||
      library.find((entry) => entry.id === M.getDefaultTemplateId(settings)) ||
      library[0];
    selectedTemplateId = chosen.id;
    return chosen;
  }
  async function saveTemplateLibrary(library) {
    const { template: legacyTemplate, ...preferences } = settings;
    const defaultId = M.getDefaultTemplateId({
      ...preferences,
      templates: library,
    });
    await saveSettings({
      ...preferences,
      templates: library,
      defaultTemplateId: defaultId,
    });
  }
  async function updateTemplateActivities(id, activities) {
    const library = templateLibrary(),
      index = library.findIndex((entry) => entry.id === id);
    if (index < 0)
      throw new Error("This template was removed on another device.");
    library[index] = {
      ...library[index],
      activities,
      updatedAt: new Date().toISOString(),
    };
    await saveTemplateLibrary(library);
  }
  function templateMetadataModal(mode) {
    const source = selectedTemplate(),
      editing = mode === "edit",
      copying = mode === "copy";
    const proposed = editing
      ? source.name
      : copying
        ? source.name + " Copy"
        : "";
    showModal(
      editing ? "Edit Template" : copying ? "Copy Template" : "New Template",
      '<div class="field"><label for="template-name">Template Name</label><input id="template-name" name="name" maxlength="100" required value="' +
        esc(proposed) +
        '" placeholder="e.g. Initial Assessment"></div><p class="form-help">' +
        (copying
          ? "Starts with a separate copy of every activity in " +
            esc(source.name) +
            "."
          : editing
            ? "Rename this template. Existing cases keep their own activities and original template name."
            : "Start with a blank template, then add the activities you need.") +
        "</p>",
      '<button type="submit" class="button primary">' +
        (editing
          ? "Save Template"
          : copying
            ? "Create Copy"
            : "Create Template") +
        "</button>",
      async (fd) => {
        const name = fd.get("name").trim(),
          library = templateLibrary();
        if (!name) throw new Error("Enter a template name.");
        if (
          library.some(
            (entry) =>
              entry.id !== (editing ? source.id : null) &&
              entry.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
          )
        )
          throw new Error(
            "A template with this name already exists. Choose a different name.",
          );
        if (editing) {
          const index = library.findIndex((entry) => entry.id === source.id);
          if (index < 0)
            throw new Error("This template was removed on another device.");
          library[index] = {
            ...library[index],
            name,
            updatedAt: new Date().toISOString(),
          };
          selectedTemplateId = source.id;
        } else {
          const fresh = copying
            ? M.copyTemplate(source, name)
            : M.newTemplate({ name });
          library.push(fresh);
          selectedTemplateId = fresh.id;
        }
        await saveTemplateLibrary(library);
        closeModal();
        render();
        toast("Template saved.");
      },
    );
  }
  function templates() {
    const library = templateLibrary(),
      selected = selectedTemplate(),
      ts = selected.activities,
      defaultTemplateId = M.getDefaultTemplateId(settings);
    return (
      header(
        "A Thoughtful Starting Point",
        "Activity Templates",
        "Build a reusable starting point, then choose the right template for each new case.",
        button("new-template", icon("plus") + " New Template", "primary"),
      ) +
      '<div class="template-library-layout"><aside class="panel template-library-panel"><div class="section-heading"><h2>Saved Templates</h2><span class="muted small">' +
      library.length +
      '</span></div><div class="template-library-list" role="group" aria-label="Saved Templates">' +
      library
        .map(
          (entry) =>
            '<button type="button" class="template-library-item' +
            (entry.id === selected.id ? " active" : "") +
            '" data-action="select-template" data-id="' +
            esc(entry.id) +
            '" aria-label="Select Template: ' +
            esc(entry.name) +
            '"' +
            (entry.id === selected.id
              ? ' aria-pressed="true"'
              : ' aria-pressed="false"') +
            '><span class="template-library-icon">' +
            icon("file") +
            "</span><span><strong>" +
            esc(entry.name) +
            "</strong><small>" +
            entry.activities.length +
            (entry.activities.length === 1 ? " Activity" : " Activities") +
            (entry.id === defaultTemplateId ? " · Default for New Cases" : "") +
            "</small></span></button>",
        )
        .join("") +
      '</div></aside><section class="template-editor"><div class="section-heading template-editor-heading"><div><h2>' +
      esc(selected.name) +
      '</h2><p class="form-help">Changes here apply to future cases. Existing cases keep their own plans.</p></div><div class="header-actions">' +
      button(
        "copy-template",
        icon("file") + " Copy Template",
        "secondary small",
      ) +
      (selected.id === "default"
        ? ""
        : button(
            "edit-template",
            icon("edit") + " Edit Template",
            "secondary small",
          )) +
      (selected.id === "default"
        ? ""
        : button(
            "delete-template",
            icon("trash") + " Delete Template",
            "danger small",
          )) +
      button("template-add", icon("plus") + " Add Activity", "primary small") +
      '</div></div><div class="notice">' +
      icon("calendar") +
      "<span><strong>Five weeks, planned backward.</strong> Week 5 ends on the final deadline. Each earlier week ends 7 days before the next. Multi-week activities appear at their Start and End.</span></div>" +
      (ts.some((task) => task.optional)
        ? '<p class="form-help template-conditional-help"><strong>If Needed</strong> activities are conditional. New cases include them; remove any that do not apply from that case. The saved template stays unchanged.</p>'
        : "") +
      '<div class="template-grid">' +
      [1, 2, 3, 4, 5]
        .map(
          (w) =>
            '<section class="panel"><div class="section-heading"><h2>Week ' +
            w +
            '</h2><span class="muted small">' +
            (5 - w) * 7 +
            ' days before due</span></div><div class="template-list">' +
            ts
              .filter((t) => t.week === w || M.activityEndWeek(t) === w)
              .map(
                (t) =>
                  '<div class="template-row" data-task-id="' +
                  esc(t.id) +
                  '" data-endpoint="' +
                  activityEndpoint(t, w) +
                  '"><span class="template-check" aria-hidden="true">' +
                  icon(activityEndpoint(t, w) === "start" ? "arrow" : "check") +
                  "</span><span>" +
                  activityTitle(t, activityEndpoint(t, w)) +
                  (t.requiresSubmission && activityEndpoint(t, w) !== "start"
                    ? '<span class="activity-workflow-tag">Written → Submitted</span>'
                    : "") +
                  ifNeededTag(t) +
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
              "+ Add to Week " + w,
              "ghost small",
              'data-week="' + w + '"',
            ) +
            "</section>",
        )
        .join("") +
      '</div><div class="form-actions">' +
      (selected.id === "default"
        ? button("reset-template", "Restore Original Default", "secondary")
        : "") +
      "</div></section></div>"
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
      " <strong>Shared Workspace</strong> · " +
      (state.lastError
        ? esc(state.lastError)
        : "Encrypted sync is connected. Refresh to see changes from another device.") +
      '</span><div class="header-actions">' +
      button("refresh-workspace", "Refresh Shared Workspace", "ghost small") +
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
      ' Sync Phone &amp; Laptop</h2><p class="form-help">Use the same cases, notes, and evidence on both devices.</p></div><span class="badge ' +
      (connected ? "completed" : "open") +
      '">' +
      (connected ? "Shared Workspace Connected" : "Optional Setup") +
      '</span></div><p class="form-help">A shared workspace stores an encrypted copy of your records. Each device needs the service address, sign-in details, and your encryption passphrase. Connected workspaces require a connection to save changes.</p>' +
      (connected
        ? '<p class="mono cloud-service-url">' +
          esc(connection.url) +
          '</p><p class="form-help">' +
          (connection.authType === "google"
            ? "Google Sign-In"
            : "Private Access Key") +
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
            "Refresh Shared Workspace",
            "secondary small",
          ) +
          (connection.authType === "google"
            ? button("google-workspace", "Sign in to Google", "secondary small")
            : "") +
          button(
            "disconnect-workspace",
            "Disconnect This Browser",
            "ghost small",
          )
        : button(
            "connect-workspace",
            "Connect Shared Workspace",
            "secondary",
          )) +
      '<a class="subtle-link" href="https://github.com/Praujekt/karen-scrum#readme" target="_blank" rel="noreferrer">Shared Workspace Setup ' +
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
      unlocking ? "Unlock Shared Workspace" : "Connect Shared Workspace",
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
          button("backup", "Download Backup", "secondary small") +
          "</div>" +
          '<div class="field"><label for="workspace-url">Workspace URL</label><input id="workspace-url" type="url" name="url" required placeholder="https://your-workspace.workers.dev" autocomplete="off"></div>' +
          '<div class="field"><label for="workspace-auth">Sign-In Method</label><select id="workspace-auth" name="authType"><option value="key">Private Access Key</option><option value="google">Google Sign-In</option></select></div>' +
          '<div class="field" id="workspace-key-field"><label for="workspace-key">Workspace Access Key</label><input id="workspace-key" name="token" type="password" required minlength="32" maxlength="512" autocomplete="off"></div>' +
          '<div class="field" id="workspace-google-field" hidden><label for="workspace-client-id">Google Client ID</label><input id="workspace-client-id" name="clientId" autocomplete="off"><p class="form-help">Use the OAuth client configured for your deployed workspace service.</p></div>') +
        '<div class="field"><label for="workspace-passphrase">Encryption Passphrase</label><input id="workspace-passphrase" name="passphrase" type="password" required minlength="12" maxlength="1024" autocomplete="off"><p class="form-help">At least 12 characters. Use the same passphrase on each device; it cannot be recovered by the service.</p></div>',
      '<button type="submit" class="button primary">' +
        (unlocking ? "Unlock Workspace" : "Connect Workspace") +
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
      (cloud ? " Cloud Reminders" : "Reminders, Even When the Laptop Is Off") +
      '</h2><p class="form-help">' +
      (cloud
        ? "The cloud service runs the schedule. Your laptop can be off."
        : "Optional: connect a cloud service for delivery while this laptop is off.") +
      "</p></div>" +
      (cloud
        ? '<span class="badge ' +
          (reminderError ? "soon" : "completed") +
          '">' +
          (reminderError ? "Needs Attention" : "Cloud Connected") +
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
        ? button("retry-reminders", "Retry Connection", "secondary small") +
          (reminderError && !R.usesWorkspace()
            ? button(
                "connect-cloud",
                "Update Cloud Connection",
                "secondary small",
              )
            : "") +
          (!R.usesWorkspace()
            ? button(
                "disconnect-cloud",
                "Disconnect Cloud Reminders",
                "ghost small",
              )
            : '<span class="form-help">Uses your shared workspace connection. Disable delivery below to pause reminders.</span>')
        : button("connect-cloud", "Connect Cloud Reminders", "secondary")) +
      '<a class="subtle-link" href="cloud-setup.html" target="_blank" rel="noreferrer">Cloud Setup Guide ' +
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
      "Connect Cloud Reminders",
      '<p class="form-help">Use the HTTPS service URL and connection token from your Cloudflare reminder service. This does not upload patient records.</p>' +
        '<div class="field"><label for="cloud-url">Service URL</label><input id="cloud-url" name="url" type="url" required autocomplete="off" placeholder="https://your-reminders.workers.dev"></div>' +
        '<div class="field"><label for="cloud-token">Connection Token</label><input id="cloud-token" name="token" type="password" required minlength="32" maxlength="512" autocomplete="off" spellcheck="false"><p class="form-help">Stored separately in this browser, excluded from case backups. Keep your original token somewhere secure.</p></div>',
      '<button type="submit" class="button primary">Connect Service</button>',
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
        "Make Room for Peace of Mind",
        "A Little Help Remembering.",
        "Choose how reminders fit your day, and keep a copy of your work.",
      ) +
      workspaceConnectionPanel() +
      reminderConnectionPanel() +
      '<div class="settings-grid"><section class="panel"><div class="section-heading"><div><h2>' +
      icon("bell") +
      ' Deadline Reminders</h2><p class="form-help">A daily digest of task and case deadlines approaching.</p></div><span class="badge ' +
      (config.enabled ? "in-progress" : "open") +
      '">' +
      (!reminder && R.hasCloud()
        ? "Status Unavailable"
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
              ? "<span>Start Karen’s Load with <strong>Start Karens Load.cmd</strong> to use local reminders, or connect a cloud service above.</span></div>"
              : "<span>Connect the optional cloud service above to enable reminders. Your cases can be used without it.</span></div>")
        : "") +
      '<form id="reminder-form"><div class="field"><label class="checkbox-label"><input type="checkbox" name="enabled" ' +
      (config.enabled ? "checked" : "") +
      '> Enable Daily Reminders</label></div><div class="form-grid"><div class="field"><label for="days-ahead">Remind Me Before Deadlines</label><select id="days-ahead" name="daysAhead">' +
      [1, 2, 3, 5, 7, 14]
        .map(
          (n) =>
            '<option value="' +
            n +
            '" ' +
            (config.daysAhead === n ? "selected" : "") +
            ">" +
            n +
            " Day" +
            (n === 1 ? "" : "s") +
            " Ahead</option>",
        )
        .join("") +
      '</select></div><div class="field"><label for="reminder-time">Daily Send Time</label><input id="reminder-time" name="time" type="time" required value="' +
      esc(config.time) +
      '"><span class="form-help">' +
      "Uses Pacific Time (PST/PDT), with daylight-saving changes handled automatically." +
      '</span></div></div><label class="checkbox-label"><input type="checkbox" name="includeOverdue" ' +
      (config.includeOverdue ? "checked" : "") +
      '> Include Overdue Work</label><hr><div class="field"><label class="checkbox-label"><input type="checkbox" name="channelEmail" ' +
      (config.channels.includes("email") ? "checked" : "") +
      '> Email Reminders <span class="badge ' +
      (enabled.email ? "completed" : "open") +
      '">' +
      (enabled.email ? "Connected" : "Setup Needed") +
      '</span></label><label for="reminder-email" class="sr-only">Reminder Email Address</label><input id="reminder-email" type="email" name="email" maxlength="254" placeholder="Her email address" value="' +
      esc(config.email) +
      '"></div><div class="field"><label class="checkbox-label"><input type="checkbox" name="channelSms" ' +
      (config.channels.includes("sms") ? "checked" : "") +
      '> SMS Reminders <span class="badge ' +
      (enabled.sms ? "completed" : "open") +
      '">' +
      (enabled.sms ? "Connected" : "Setup Needed") +
      '</span></label><label for="reminder-phone" class="sr-only">Reminder Phone Number</label><input id="reminder-phone" type="tel" name="phone" maxlength="20" placeholder="+15551234567" value="' +
      esc(config.phone) +
      '"><span class="form-help">Include the country code. Provider charges may apply.</span></div><p class="form-help reminder-privacy">' +
      icon("shield") +
      ' Messages contain counts and dates only. Patient names, notes, and evidence are never included.</p><div id="reminder-error" class="form-error" role="alert" hidden></div><div class="form-actions"><button type="submit" class="button primary" ' +
      (!reminder ? "disabled" : "") +
      ">Save Reminders</button>" +
      button(
        "test-reminder",
        "Send Test Reminder",
        "secondary",
        !reminder ? "disabled" : "",
      ) +
      '</div></form><details class="setup-details"><summary>Connect Email or SMS</summary><p>Email uses <a href="https://resend.com/docs/introduction" target="_blank" rel="noreferrer">Resend</a>; SMS uses <a href="https://www.twilio.com/docs/messaging" target="_blank" rel="noreferrer">Twilio</a>. A cloud service runs the schedule while the laptop is off. <a href="cloud-setup.html" target="_blank" rel="noreferrer">Read the Cloud Setup Guide</a>.</p><p>Local reminders are also available with Start Karens Load.cmd and provider credentials in the local .env file. Local delivery requires the laptop awake, online, and the service running.</p></details><div class="backup-status">' +
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
      ' Backup & Restore</h2></div><p class="muted">Download all cases, notes, your template, and uploaded evidence in one portable backup.</p><div class="backup-buttons">' +
      button("backup", icon("download") + " Download Backup", "primary") +
      button("restore", icon("upload") + " Restore Backup", "secondary") +
      '</div><p class="form-help">Backups contain patient information and are not encrypted. Store them in an approved, secure location. Provider credentials are excluded.</p><p class="backup-status">' +
      (settings.lastBackup
        ? "Last backup downloaded " + stamp(settings.lastBackup)
        : "No backup downloaded yet.") +
      '</p></section><section class="tip-card"><h3>' +
      icon("shield") +
      ' Your Workspace, Your Records.</h3><p>Each browser keeps a local copy. A connected shared workspace also stores encrypted copies for your other devices. Clearing browser data removes this device’s copy.</p><p>Reminder services receive only counts, dates, and delivery preferences. Connection credentials are stored separately and excluded from case backups.</p><p>Use your organization’s approved device and storage practices for patient records.</p></section><section class="panel danger-zone"><h3>Workspace Data</h3><p class="form-help">Remove cases, uploaded copies, and the custom template. When shared sync is connected, clearing also updates the shared workspace.</p>' +
      button("clear-all", "Clear Workspace…", "danger small") +
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
      '</h2><button type="button" class="icon-button" data-action="close-modal" aria-label="Close Dialog">' +
      icon("close") +
      '</button></div><div class="modal-body">' +
      body +
      '<div id="modal-error" class="form-error" role="alert" hidden></div></div><div class="modal-footer">' +
      button("close-modal", "Cancel", "secondary") +
      (footer ||
        '<button type="submit" class="button primary">Save Changes</button>') +
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
      due = c ? c.dueDate : M.addDays(start, 34),
      library = templateLibrary(),
      defaultTemplateId = M.getDefaultTemplateId(settings);
    showModal(
      editing ? "Edit Case" : "A New Case, a Clear Plan",
      '<div class="field"><label for="patient-name">Patient Name <span class="required">*</span></label><input id="patient-name" name="name" maxlength="200" required autocomplete="off" value="' +
        esc(c ? c.name : "") +
        '" placeholder="First and last name"></div>' +
        (editing
          ? ""
          : '<div class="field"><label for="case-template">Template</label><select id="case-template" name="templateId">' +
            library
              .map(
                (entry) =>
                  '<option value="' +
                  esc(entry.id) +
                  '"' +
                  (entry.id === defaultTemplateId ? " selected" : "") +
                  ">" +
                  esc(entry.name) +
                  "</option>",
              )
              .join("") +
            '</select><p class="form-help">This case gets its own copy. Changing its activities will not change the saved template.</p></div>') +
        '<div class="form-grid"><div class="field"><label for="case-opened">Case Opened</label><input id="case-opened" name="startDate" type="date" required value="' +
        start +
        '"></div><div class="field"><label for="final-due">Final Due Date <span class="required">*</span></label><input id="final-due" name="dueDate" type="date" required value="' +
        due +
        '"></div></div><div class="schedule-preview" id="schedule-preview"></div>' +
        (editing
          ? '<div class="field"><label class="checkbox-label"><input type="checkbox" name="shift" checked> Shift Activity Dates When the Deadline Changes</label><p class="form-help">Moves every activity by the same number of days, preserving custom spacing.</p></div>'
          : '<div class="field"><label for="initial-note">Initial Note <span class="muted">(optional)</span></label><textarea id="initial-note" name="notes" maxlength="50000" rows="3" placeholder="Anything useful to know about this case…"></textarea></div><p class="form-help">Weekly dates work backward from the final deadline. Every activity can be customized for this case.</p>'),
      '<button type="submit" class="button primary">' +
        (editing ? "Save Case" : "Create Case") +
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
          const chosen = templateLibrary().find(
            (entry) => entry.id === fd.get("templateId"),
          );
          if (!chosen)
            throw new Error(
              "This template is no longer available. Reopen the new case form and choose another template.",
            );
          const fresh = M.createCase({
            name: fd.get("name"),
            startDate: fd.get("startDate"),
            dueDate: fd.get("dueDate"),
            notes: fd.get("notes"),
            template: chosen.activities,
            templateId: chosen.id,
            templateName: chosen.name,
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
      templateRecord = template ? selectedTemplate() : null,
      ts = template ? templateRecord.activities : c.tasks,
      old = id ? ts.find((t) => t.id === id) : null;
    showModal(
      old ? "Edit Activity" : "Add an Activity",
      '<div class="field"><label for="activity-title">Activity Name</label><input id="activity-title" name="title" maxlength="500" required value="' +
        esc(old ? old.title : "") +
        '"></div><label class="checkbox-label activity-option"><input type="checkbox" id="activity-spans" name="spansWeeks"' +
        (old && M.activitySpansWeeks(old) ? " checked" : "") +
        '> Spans Multiple Weeks</label><div class="form-grid"><div class="field"><label id="activity-week-label" for="activity-week">Plan Week</label><select id="activity-week" name="week">' +
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
        '</select></div><div class="field" id="activity-end-field" hidden><label for="activity-end-week">End Week</label><select id="activity-end-week" name="endWeek">' +
        [1, 2, 3, 4, 5]
          .map(
            (w) =>
              '<option value="' +
              w +
              '"' +
              (w === (old ? M.activityEndWeek(old) : week || 1)
                ? " selected"
                : "") +
              ">Week " +
              w +
              "</option>",
          )
          .join("") +
        "</select></div>" +
        (!template
          ? '<div class="field"><label for="activity-due">Activity Due Date</label><input id="activity-due" type="date" name="dueDate" required value="' +
            (old ? old.dueDate : M.taskDue(c.startDate, c.dueDate, week || 1)) +
            '"></div>'
          : "") +
        '</div><p class="form-help" id="activity-range-help" hidden>A multi-week activity appears at its Start and End. Complete it at the End entry; it counts as one activity.</p><label class="checkbox-label activity-option"><input type="checkbox" name="requiresSubmission"' +
        (old && old.requiresSubmission ? " checked" : "") +
        '> Track Written and Submitted Separately</label><p class="form-help">Use two steps for activities that need a written draft and a final submission. Only Submitted counts as complete.</p><label class="checkbox-label activity-option"><input type="checkbox" name="optional" ' +
        (old && old.optional ? "checked" : "") +
        '> Only If Needed</label><p class="form-help">Use for a conditional activity, such as an ROI or ADOS. It still counts toward progress and due lists until completed or removed.' +
        (template
          ? " New cases include it; remove it from a case if it does not apply."
          : " If it does not apply, remove it from this case without changing the template.") +
        "</p>" +
        (!template
          ? '<p class="form-help">Set a date that fits this case. It can differ from the weekly target.</p>'
          : ""),
      (old
        ? button(
            template ? "template-delete" : "delete-task",
            icon("trash") + " Remove Activity",
            "danger small",
            'data-id="' + esc(old.id) + '"',
          )
        : "") +
        '<button type="submit" class="button primary">' +
        (old ? "Save Activity" : "Add Activity") +
        "</button>",
      async (fd) => {
        const t = {
          id: old ? old.id : M.uid(),
          title: fd.get("title").trim(),
          week: Number(fd.get("week")),
          endWeek: fd.has("spansWeeks")
            ? Number(fd.get("endWeek"))
            : Number(fd.get("week")),
          requiresSubmission: fd.has("requiresSubmission"),
          optional: fd.has("optional"),
        };
        if (!t.title) throw new Error("Enter an activity name.");
        if (t.endWeek < t.week)
          throw new Error("The end week must be on or after the start week.");
        if (template) {
          const latestTemplate = templateLibrary().find(
            (entry) => entry.id === templateRecord.id,
          );
          if (!latestTemplate)
            throw new Error("This template was removed on another device.");
          const updated = latestTemplate.activities;
          if (old) {
            const index = updated.findIndex((x) => x.id === old.id);
            if (index < 0)
              throw new Error(
                "This template activity was removed on another device.",
              );
            updated[index] = t;
          } else updated.push(t);
          await updateTemplateActivities(templateRecord.id, updated);
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
          t.written = t.requiresSubmission
            ? Boolean(latestTask && (latestTask.written || latestTask.done))
            : false;
          t.dueDate = fd.get("dueDate");
          M.dateDiff(t.dueDate, t.dueDate);
          if (
            M.activitySpansWeeks(t) &&
            t.dueDate < M.activityStartDate(latest, t)
          )
            throw new Error(
              "The activity due date must be on or after the start of its week range.",
            );
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
    updateActivityEditor(false);
  }
  function updateActivityEditor(updateDueDate) {
    const start = modal.querySelector("#activity-week"),
      end = modal.querySelector("#activity-end-week"),
      spans = modal.querySelector("#activity-spans");
    if (!start || !end || !spans) return;
    const week = Number(start.value);
    if (Number(end.value) < week) end.value = String(week);
    Array.from(end.options).forEach((option) => {
      option.disabled = Number(option.value) < week;
    });
    document.getElementById("activity-week-label").textContent = spans.checked
      ? "Start Week"
      : "Plan Week";
    document.getElementById("activity-end-field").hidden = !spans.checked;
    document.getElementById("activity-range-help").hidden = !spans.checked;
    const due = modal.querySelector("#activity-due");
    if (updateDueDate && due) {
      const c = currentCase();
      due.value = M.taskDue(
        c.startDate,
        c.dueDate,
        spans.checked ? Number(end.value) : week,
      );
    }
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
      "karens-load-backup-" + M.today() + ".json",
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
  function navigate(next, selectedFilter) {
    route = next;
    query = "";
    if (next === "overview") filter = "active";
    if (next === "cases") filter = selectedFilter || "all";
    window.location.hash =
      next === "case"
        ? "case/" + encodeURIComponent(selectedId)
        : next === "cases"
          ? caseFilterPaths[filter] || "cases"
          : next;
    render();
    window.scrollTo(0, 0);
  }
  async function loadDemo(replaceExamples = false) {
    if (cases.length && replaceExamples !== true)
      throw new Error("Example cases are available in an empty workspace.");
    const previous = await DB.exportSync(),
      previousDemoFiles = new Set(
        previous.cases
          .filter((record) => record.demo)
          .flatMap((record) =>
            record.attachments
              .filter((file) => file.kind === "file")
              .map((file) => file.fileId),
          ),
      );
    const examples = M.makeDemo().map((c) => ({ ...c, demo: true }));
    const demonstration = examples.find((c) => c.status === "in_progress");
    const complete = examples.find((c) => c.status === "completed");
    const files = [demonstration, complete].map((record, index) => {
      const id = M.uid(),
        name = index
          ? "Sample submission checklist.txt"
          : "Sample assessment evidence.txt";
      const text =
        "KAREN'S LOAD - FICTIONAL EXAMPLE ONLY\n\nPatient: " +
        record.name +
        "\nThis file demonstrates evidence uploads and downloads.\nIt is not a real patient record or clinical report.\n\n" +
        (index
          ? "Example: report finalized; sections uploaded; paperwork submitted.\n"
          : "Example: teacher materials received; parent interview scheduled; remaining activities tracked in Karen's Load.\n") +
        "\nYou can remove this sample safely using Remove examples.\n";
      const encodedText = new TextEncoder().encode(text);
      record.attachments.push({
        id: M.uid(),
        name,
        kind: "file",
        fileId: id,
        size: encodedText.byteLength,
        createdAt: new Date().toISOString(),
      });
      return {
        id,
        name,
        type: "text/plain",
        data: btoa(
          Array.from(encodedText, (byte) => String.fromCharCode(byte)).join(""),
        ),
      };
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
    const keptCases = previous.cases.filter((record) => !record.demo);
    const seedSettings = {
      ...settings,
      initialized: true,
      demo: true,
      demoVersion: 2,
    };
    // Refresh only owned fictional records. Keep real records, settings, and file bytes atomically.
    await DB.importSync({
      cases: [...keptCases, ...examples],
      settings: seedSettings,
      files: [
        ...previous.files.filter((file) => !previousDemoFiles.has(file.id)),
        ...files.map((file) => ({
          id: file.id,
          blob: new Blob(
            [
              Uint8Array.from(atob(file.data), (character) =>
                character.charCodeAt(0),
              ),
            ],
            { type: file.type },
          ),
        })),
      ],
    });
    cases = [...keptCases, ...examples];
    settings = seedSettings;
    render();
    queueReminderSync();
    toast(
      replaceExamples === true
        ? "Examples refreshed. Cases you added are kept."
        : "Fictional examples loaded.",
    );
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
      "Add a Document Reference",
      '<div class="field"><label for="reference-name">Document Name</label><input id="reference-name" name="name" maxlength="500" required placeholder="e.g. Signed assessment plan"></div><div class="field"><label for="reference-kind">Reference Type</label><select id="reference-kind" name="kind"><option value="path">File on This Laptop</option><option value="paper">Paper Document Location</option><option value="drive">Google Drive or Docs</option><option value="link">Other Web Document Link</option></select></div><div class="field"><label for="reference-value">File Path or Document URL</label><input id="reference-value" name="value" maxlength="4000" required placeholder="File path, paper filing location, or document URL"><p class="form-help">For paper, record where it is filed. Local references save a location, not a copy; use Copy path in File Explorer. Google Drive and Docs links open in your signed-in browser; files are not uploaded here.</p></div>',
      '<button type="submit" class="button primary">Add Reference</button>',
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
    "overview-range": (el) => {
      const days = Number(el.dataset.days);
      overviewSelectedDate = days === 7 ? null : M.addDays(M.today(), days);
      render();
    },
    "overview-submit": (el) =>
      withWorkspaceWrite(async () => {
        const current = cases.find((record) => record.id === el.dataset.caseId);
        if (!current || current.status === "completed")
          throw new Error(
            "This case is no longer active. Refresh the Overview.",
          );
        const copy = structuredClone(current),
          index = copy.tasks.findIndex((task) => task.id === el.dataset.id),
          task = copy.tasks[index];
        if (!task)
          throw new Error("This activity was removed. Refresh the Overview.");
        if (task.done) {
          render();
          return;
        }
        if (!M.isAwaitingSubmission(task))
          throw new Error(
            "This activity is no longer marked Written. Open the case to review it.",
          );
        copy.tasks[index] = M.setActivityChecks(task, { done: true });
        if (copy.status === "open") copy.status = "in_progress";
        await saveCase(copy);
        render();
        toast("Activity marked submitted.");
      }),
    "case-status-filter": (el) => navigate("cases", el.dataset.filter),
    "select-template": (el) => {
      selectedTemplateId = el.dataset.id;
      render();
    },
    "new-template": () => templateMetadataModal("new"),
    "copy-template": () => templateMetadataModal("copy"),
    "edit-template": () => templateMetadataModal("edit"),
    "delete-template": () => {
      const chosen = selectedTemplate();
      if (chosen.id === "default")
        throw new Error(
          "The shipped Default template is kept available. You can edit its activities or create a copy.",
        );
      confirmAction(
        "Delete Template?",
        "Delete <strong>" +
          esc(chosen.name) +
          "</strong> from the template library? Existing cases keep their own activities.",
        "Delete Template",
        async () => {
          const library = templateLibrary().filter(
            (entry) => entry.id !== chosen.id,
          );
          if (!library.length)
            throw new Error("Keep at least one template in the library.");
          await saveTemplateLibrary(library);
          selectedTemplateId = M.getDefaultTemplateId(settings);
          closeModal();
          render();
          toast("Template deleted.");
        },
      );
    },
    "new-case": () => caseModal(false),
    "edit-case": () => caseModal(true),
    "close-modal": closeModal,
    "open-case": (el) => {
      selectedId = el.dataset.id;
      detailTab = "activities";
      navigate("case");
    },
    metric: (el) => navigate("cases", el.dataset.filter),
    "detail-tab": (el) => {
      detailTab = el.dataset.tab;
      render();
    },
    "add-task": () => taskModal(null, false),
    "edit-task": (el) => taskModal(el.dataset.id, false),
    "delete-task": (el) => {
      const id = el.dataset.id;
      confirmAction(
        "Remove This Activity?",
        "The activity and its completion mark will be removed from this case.",
        "Remove Activity",
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
        "Delete Case",
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
        "Edit Note",
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
        "Delete This Note?",
        "This note will be removed from the case.",
        "Delete Note",
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
          "Document Location",
          '<div class="field"><label for="copy-location">' +
            (a.kind === "paper"
              ? "Paper Document Location"
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
        "Remove This Evidence?",
        "This removes the saved copy or reference from the case. The original document is kept.",
        "Remove Evidence",
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
      const id = el.dataset.id,
        templateId = selectedTemplate().id;
      confirmAction(
        "Remove Template Activity?",
        "New cases will no longer include this activity. Existing cases keep their own plans.",
        "Remove Activity",
        async () => {
          const chosen = templateLibrary().find(
            (entry) => entry.id === templateId,
          );
          if (!chosen)
            throw new Error("This template was removed on another device.");
          await updateTemplateActivities(
            templateId,
            chosen.activities.filter((t) => t.id !== id),
          );
          closeModal();
          render();
        },
      );
    },
    "reset-template": () =>
      confirmAction(
        "Restore Original Default?",
        "Replace Default's activities with the original 19 activities. Other templates and existing cases keep their own plans.",
        "Restore Template",
        async () => {
          await updateTemplateActivities("default", M.template());
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
        "Disconnect This Browser?",
        "The local copy stays on this device and becomes a local workspace. Cloud records are kept. A separate cloud reminder schedule is unchanged.",
        "Disconnect Browser",
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
        "Disconnect Cloud Reminders?",
        "This first disables the cloud schedule, then removes the connection token from this browser. Cases and evidence stay here.",
        "Disconnect Service",
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
    "refresh-demo": () =>
      confirmAction(
        "Refresh Example Cases?",
        "Replace only the fictional examples with the latest demo, including week ranges and Written/Submitted stages. Cases you added keep their notes, activities, and evidence.",
        "Refresh Examples",
        async () => {
          await loadDemo(true);
          closeModal();
          navigate("overview");
        },
      ),
    "clear-demo": () =>
      confirmAction(
        "Remove Example Cases?",
        "Only the fictional example cases will be removed. Cases you added are kept.",
        "Remove Examples",
        async () => {
          await clearDemo();
          closeModal();
        },
      ),
    "clear-all": () =>
      confirmAction(
        "Clear This Workspace?",
        sync.isConnected()
          ? "All shared cases, notes, uploaded copies, and custom template settings will be removed from the cloud workspace and every connected device when it refreshes. Download a backup first. Connected reminders must be paused before clearing."
          : "All cases, notes, uploaded copies, and custom template settings will be permanently removed from this browser. Download a backup first. Connected reminders must be paused before clearing.",
        "Clear Everything",
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
        "Send a Test Reminder?",
        "A generic test will be sent now to the recipient and channels in your saved reminder settings. No patient information is included.",
        "Send Test",
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
          "case-status-filter",
          "overview-range",
          "select-template",
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
        el.dataset.taskWritten ||
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
    if (el.id === "overview-through") {
      if (el.value) M.dateDiff(M.today(), el.value);
      overviewSelectedDate = el.value || null;
      render();
      return;
    }
    if (el.id === "workspace-auth") {
      const google = el.value === "google";
      document.getElementById("workspace-key-field").hidden = google;
      document.getElementById("workspace-google-field").hidden = !google;
      document.getElementById("workspace-key").required = !google;
      document.getElementById("workspace-client-id").required = google;
      return;
    }
    if (el.id === "case-filter") {
      navigate("cases", el.value);
      return;
    }
    if (
      ["activity-week", "activity-end-week", "activity-spans"].includes(el.id)
    ) {
      updateActivityEditor(true);
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
          "Replace Workspace from Backup?",
          "Restore <strong>" +
            data.cases.length +
            " cases</strong> and " +
            data.files.length +
            " uploaded files. " +
            (sync.isConnected()
              ? "This replaces the shared workspace for every connected device when it refreshes. "
              : "This replaces the current workspace. ") +
            "Reminder connections stay separate and must be paused before restore.",
          "Restore Backup",
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
            ? "Choose a valid Karen’s Load backup."
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
            "Complete This Case?",
            "Some activities are still unchecked. Completing the case removes it from deadline reminders. You can reopen it later.",
            "Complete Case",
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
    if (el.dataset.taskCheck || el.dataset.taskWritten) {
      el.disabled = true;
      try {
        const c = structuredClone(currentCase()),
          index = c.tasks.findIndex(
            (t) => t.id === (el.dataset.taskCheck || el.dataset.taskWritten),
          );
        if (index < 0) throw new Error("This activity is no longer available.");
        const t = M.setActivityChecks(
          c.tasks[index],
          el.dataset.taskWritten
            ? { written: el.checked }
            : { done: el.checked },
        );
        c.tasks[index] = t;
        if ((t.done || t.written) && c.status === "open")
          c.status = "in_progress";
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
    } else if (hash === "cases" || hash.startsWith("cases/")) {
      route = "cases";
      filter =
        hash === "cases/open"
          ? "open"
          : Object.keys(caseFilterPaths).find(
              (value) => caseFilterPaths[value] === hash,
            ) || "all";
    } else if (
      ["overview", "cases", "upcoming", "templates", "settings"].includes(hash)
    ) {
      route = hash;
      if (route === "overview") filter = "active";
    } else route = "overview";
  }
  async function init() {
    try {
      await DB.init();
      [cases, settings] = await Promise.all([DB.getCases(), DB.getSettings()]);
      if (!settings.initialized && !sync.isConnected()) {
        if (!cases.length) await loadDemo();
        else await saveSettings({ ...settings, initialized: true });
      }
      if (
        !sync.isConnected() &&
        settings.demo &&
        settings.demoVersion !== 2 &&
        cases.some((record) => record.demo)
      ) {
        try {
          await loadDemo(true);
        } catch (error) {
          toast(
            "The examples could not be refreshed. Your saved cases were kept. " +
              error.message,
            true,
          );
        }
      }
      if (!Array.isArray(settings.templates) && !sync.isConnected()) {
        await saveTemplateLibrary(templateLibrary());
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
        '<main class="loading-screen"><h1>We Couldn’t Open Your Workspace.</h1><p>' +
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
              '</div><h1>Your Workspace Is Already Open.</h1><p>Keep one Karen’s Load tab open so every change stays in sync. Close the other tab, then reload this one.</p><button class="button primary" id="retry-workspace">Try Again</button></main>';
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
      '<main class="loading-screen"><h1>This Browser Can’t Safely Open the Workspace.</h1><p>Open Karen’s Load in an updated Chrome, Edge, or Firefox browser at its local address.</p></main>';
})();

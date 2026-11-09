/* Sidebar-only demonstration: preferences, thread actions and directory fixtures stay in memory. */
function createSidebarControls({ onAddWorkspace, getStatus }) {
  const root = document.querySelector("#sidebar");
  const find = (selector) => root.querySelector(selector);
  const list = find(".sidebar-list"),
    empty = find(".search-empty"),
    search = find("#search");
  const home = find("#sidebar-home"),
    detail = find("#sidebar-detail");
  const view = { group: "workspace", order: "updated", archive: "hide" };
  const workspaces = new Set(["codex-host-web", "console-ui"]);
  const folders = ["codex-host-web", "console-ui", "mobile-playground", "design-notes"];
  const identities = {
    "Claude Code": "claude.svg",
    Codex: "codex.png",
    Pi: "pi.svg",
    Cursor: "cursor.svg",
  };
  let selected = "main",
    detailRow,
    detailTrigger;
  const fixtures = [...list.querySelectorAll(".thread-row")].map((element, index) => ({
    id: element.dataset.thread,
    title: element.querySelector("strong").textContent,
    harness: ["Claude Code", "Codex", "Pi", "Claude Code", "Claude Code", "Cursor"][index],
    project: element.closest(".project-group").querySelector("summary").textContent.trim(),
    updated: [6, 5, 4, 2, 1, 3][index],
    age: ["12分", "18分", "26分", "1小时", "2小时", "48分"][index],
  }));
  const icon = (name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  };
  function rowStatus(row) {
    return row.archived ? "已归档" : getStatus(row.id);
  }
  function paintRow(row) {
    const status = rowStatus(row);
    const pendingLabel = { 等待批准: "待审批", 等待回答: "待回答", 计划待审: "计划待审" }[status];
    const state = row.archived
      ? "idle"
      : pendingLabel
        ? "warning"
        : status === "运行中"
          ? "ongoing"
          : "idle";
    row.element.classList.toggle("selected", row.id === selected);
    row.element.classList.toggle("archived-row", row.archived);
    if (row.id === selected) row.link.setAttribute("aria-current", "page");
    else row.link.removeAttribute("aria-current");
    row.link.setAttribute(
      "aria-label",
      `${row.title}，${row.harness}，${status}，最近更新 ${row.age}（示例）`,
    );
    row.meta.replaceChildren();
    row.meta.dataset.state = state;
    row.meta.setAttribute("aria-hidden", "true");
    if (state === "warning") {
      const dot = document.createElement("span");
      dot.className = "row-state-dot";
      row.meta.append(dot, document.createTextNode(pendingLabel));
    } else if (state === "ongoing") {
      const spinner = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      spinner.setAttribute("viewBox", "0 0 24 24");
      spinner.classList.add("row-spinner");
      spinner.innerHTML =
        '<g class="row-spinner-motion"><circle class="row-spinner-track" cx="12" cy="12" r="9.5"/><circle class="row-spinner-arc" cx="12" cy="12" r="9.5"/></g>';
      row.meta.append(spinner);
    } else row.meta.textContent = row.age;
  }
  function makeRow({
    id,
    title,
    harness,
    project,
    archived = false,
    age = "刚刚",
    updated = Date.now(),
  }) {
    const element = document.createElement("div");
    element.className = "thread-row";
    const link = document.createElement("a");
    link.className = "thread-open";
    link.href = `#${id === "main" ? "thread" : id}`;
    link.dataset.thread = id;
    const mark = document.createElement("img");
    mark.className = "thread-harness-icon";
    mark.src = `assets/harness-${identities[harness]}`;
    mark.width = 16;
    mark.height = 16;
    mark.alt = "";
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "thread-copy";
    const strong = document.createElement("strong");
    strong.textContent = title;
    copy.append(strong);
    const meta = document.createElement("span");
    meta.className = "row-meta";
    link.append(mark, copy, meta);
    const more = document.createElement("button");
    more.className = "icon-button thread-more";
    more.dataset.sideAction = "thread-options";
    more.dataset.rowId = id;
    more.setAttribute("aria-label", `${title}的会话选项`);
    more.setAttribute("aria-controls", "sidebar-detail");
    more.append(icon("more"));
    element.append(link, more);
    const row = {
      id,
      title,
      harness,
      project,
      archived,
      age,
      updated,
      pinned: false,
      element,
      link,
      meta,
      more,
    };
    paintRow(row);
    return row;
  }
  const rows = fixtures.map(makeRow);
  rows.push(
    makeRow({
      id: "archived",
      title: "旧版导航验证",
      harness: "Codex",
      project: "codex-host-web",
      archived: true,
      updated: 0,
      age: "3天",
    }),
  );
  function renderList() {
    const expanded = new Map(
      [...list.querySelectorAll("[data-workspace-group]")].map((group) => [
        group.dataset.workspaceGroup,
        group.open,
      ]),
    );
    rows.forEach(paintRow);
    const q = search.value.trim().toLowerCase();
    const visible = rows.filter(
      (row) =>
        (view.archive === "all" || (view.archive === "only") === row.archived) &&
        `${row.title} ${row.harness} ${row.project} ${rowStatus(row)}`.toLowerCase().includes(q),
    );
    if (view.order === "updated") visible.sort((a, b) => b.updated - a.updated);
    list.replaceChildren();
    function group(name, members, container, glyph = "folder") {
      const section = document.createElement("details");
      section.className = "project-group";
      section.dataset.workspaceGroup = name;
      section.open = q ? true : (expanded.get(name) ?? true);
      const summary = document.createElement("summary");
      const label = document.createElement("span");
      label.textContent = name;
      const chevron = icon("down");
      chevron.classList.add("chevron", "push");
      summary.append(icon(glyph), label, chevron);
      section.append(summary);
      members.forEach((row) => section.append(row.element));
      if (!members.length) {
        const hint = document.createElement("p");
        hint.className = "workspace-empty";
        hint.textContent = "暂无会话";
        section.append(hint);
      }
      container.append(section);
      return section;
    }
    const pinned = visible.filter((row) => row.pinned),
      regular = visible.filter((row) => !row.pinned);
    if (pinned.length) group("置顶", pinned, list, "pin");
    if (view.group === "list") regular.forEach((row) => list.append(row.element));
    else {
      let container = list;
      if (view.group === "tree" && (regular.length || !q)) {
        const tree = document.createElement("details");
        tree.className = "project-group workspace-tree";
        tree.open = true;
        const summary = document.createElement("summary");
        summary.append(icon("folder"), document.createTextNode("work"));
        tree.append(summary);
        list.append(tree);
        container = tree;
      }
      for (const project of workspaces) {
        const projectRows = regular.filter((row) => row.project === project);
        const unused = !rows.some((row) => row.project === project);
        if (projectRows.length || (unused && view.archive !== "only" && !q))
          group(project, projectRows, container);
      }
    }
    list.append(empty);
    empty.hidden =
      visible.length > 0 ||
      (view.group !== "list" &&
        !q &&
        view.archive !== "only" &&
        [...workspaces].some((project) => !rows.some((row) => row.project === project)));
    empty.textContent = q
      ? "没有匹配的对话。请试试其他关键词或调整归档筛选。"
      : "当前筛选下没有对话。可以在视图选项中调整筛选。";
    const filter = find(".sidebar-filter");
    filter.hidden = view.archive === "hide";
    filter.textContent = view.archive === "only" ? "仅显示已归档 · 调整" : "包含已归档 · 调整";
  }
  function reset() {
    home.hidden = false;
    detail.hidden = true;
  }
  function back() {
    reset();
    if (detailTrigger?.isConnected && detailTrigger.getClientRects().length) detailTrigger.focus();
    else find('.sidebar-toolbar [data-side-action="view-options"]').focus();
  }
  function updateRowDetail() {
    find("#row-detail-name").textContent = detailRow.title;
    find("#row-detail-harness").textContent = detailRow.harness;
    find("#row-detail-project").textContent = detailRow.project;
    find("#row-detail-status").textContent = rowStatus(detailRow);
    find("#row-detail-time").textContent = `${detailRow.age} · 示例`;
    find("#row-open-link").href = detailRow.link.getAttribute("href");
    find('[data-side-action="pin-thread"]').textContent = detailRow.pinned
      ? "取消置顶"
      : "置顶会话";
    find('[data-side-action="archive-thread"]').textContent = detailRow.archived
      ? "恢复会话"
      : "归档会话";
  }
  function show(kind, rowId, trigger = document.activeElement) {
    if (kind === "sidebar-more") {
      reset();
      return;
    }
    detailTrigger = trigger;
    home.hidden = true;
    detail.hidden = false;
    find("#sidebar-detail-title").textContent =
      kind === "view-options" ? "视图选项" : kind === "thread-options" ? "会话选项" : "添加工作区";
    find("#sidebar-detail-body").replaceChildren(
      document.querySelector(`#sidebar-${kind}`).content.cloneNode(true),
    );
    if (kind === "thread-options") {
      detailRow = rows.find((row) => row.id === rowId);
      updateRowDetail();
    } else if (kind === "view-options") {
      for (const key of Object.keys(view))
        find(`input[name="sidebar-${key}"][value="${view[key]}"]`).checked = true;
    } else {
      for (const name of folders) {
        const label = document.createElement("label");
        label.className = "host-folder";
        const copy = document.createElement("span");
        copy.textContent = name;
        const small = document.createElement("small");
        small.textContent = workspaces.has(name) ? "已添加" : `/Users/demo/work/${name}`;
        copy.append(small);
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "host-folder";
        input.value = name;
        input.disabled = workspaces.has(name);
        label.append(copy, input);
        find("#host-folders").append(label);
      }
    }
    find("#sidebar-detail-body").scrollTop = 0;
    find("#sidebar-detail-title").focus({ preventScroll: true });
  }
  function dismiss() {
    if (!detail.hidden) {
      back();
      return true;
    }
    if (!find("#sidebar-search").hidden) {
      if (search.value) {
        search.value = "";
        renderList();
      } else {
        find("#sidebar-search").hidden = true;
        find('[data-side-action="search"]').setAttribute("aria-expanded", "false");
        find('[data-side-action="search"]').focus();
      }
      return true;
    }
    return false;
  }
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-side-action]");
    if (!button || button.disabled) return;
    switch (button.dataset.sideAction) {
      case "search":
        find("#sidebar-search").hidden = false;
        button.setAttribute("aria-expanded", "true");
        search.focus();
        break;
      case "view-options":
      case "add-workspace":
      case "thread-options":
        show(button.dataset.sideAction, button.dataset.rowId, button);
        break;
      case "back":
        back();
        break;
      case "pin-thread":
        detailRow.pinned = !detailRow.pinned;
        renderList();
        updateRowDetail();
        break;
      case "archive-thread":
        detailRow.archived = !detailRow.archived;
        renderList();
        updateRowDetail();
        break;
      case "confirm-workspace": {
        const name = find('input[name="host-folder"]:checked')?.value;
        if (!folders.includes(name) || workspaces.has(name)) return;
        workspaces.add(name);
        renderList();
        reset();
        onAddWorkspace(name);
        break;
      }
    }
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (input.name?.startsWith("sidebar-")) {
      view[input.name.slice(8)] = input.value;
      renderList();
    }
    if (input.name === "host-folder")
      find('[data-side-action="confirm-workspace"]').disabled = false;
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dismiss()) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  search.addEventListener("input", renderList);
  renderList();
  return {
    reset,
    show,
    dismiss,
    selectThread(id) {
      selected = id;
      rows.forEach(paintRow);
    },
    addThread(thread) {
      rows.push(makeRow(thread));
      renderList();
    },
  };
}

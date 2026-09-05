// Browser-only presentation. The renderer validates the embedded report before publication.
(() => {
  const $ = (id) => document.getElementById(id);
  const verdicts = [
    { key: "ACCEPT", label: "建议合入", className: "accept", hint: "目标有价值，实现与收益匹配" },
    {
      key: "SIMPLIFY",
      label: "精简后合入",
      className: "simplify",
      hint: "保留功能收益，删掉多余机制",
    },
    { key: "DISCUSS", label: "需要讨论", className: "discuss", hint: "先明确场景或产品取舍" },
    {
      key: "DECLINE",
      label: "不建议合入",
      className: "decline",
      hint: "增量收益不足，或长期代价过高",
    },
  ];
  const ciLabels = {
    pass: "通过",
    fail: "失败",
    pending: "进行中",
    cancelled: "已取消",
    skipped: "已跳过",
    none: "无检查",
    unknown: "未知",
    mixed: "混合状态",
  };
  const conflictLabels = { clear: "无冲突", conflicting: "有冲突", unknown: "冲突未知" };

  function element(tag, className = "", text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function link(label, href, className = "") {
    const node = element("a", className, label);
    const url = new URL(href);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("报告包含不安全链接");
    }
    node.href = url.href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
  }

  function integration(pr) {
    const row = element("div", "integration");
    row.setAttribute("aria-label", "集成参考，不影响分组");
    const tone =
      pr.integration.ci === "pass" ? "good" : pr.integration.ci === "fail" ? "warn" : "neutral";
    row.append(
      element("span", `status ${tone}`, `CI ${ciLabels[pr.integration.ci]}`),
      element(
        "span",
        `status ${pr.integration.conflict === "conflicting" ? "warn" : "neutral"}`,
        conflictLabels[pr.integration.conflict],
      ),
    );
    return row;
  }

  function textSection(title, text) {
    const section = element("section", "detail-section");
    section.append(element("h3", "", title), element("p", "", text));
    return section;
  }

  function listSection(title, items) {
    const section = element("section", "detail-section");
    const list = element("ul");
    list.append(...items.map((item) => element("li", "", item)));
    section.append(element("h3", "", title), list);
    return section;
  }

  try {
    const report = JSON.parse($("report-data").textContent);
    let view = "board";
    const counts = Object.fromEntries(
      verdicts.map((verdict) => [
        verdict.key,
        report.prs.filter((pr) => pr.verdict === verdict.key).length,
      ]),
    );

    function showDetail(pr) {
      const verdict = verdicts.find((item) => item.key === pr.verdict);
      const badge = element("div", verdict.className);
      badge.append(element("span", "verdict-pill", `${verdict.label} · ${verdict.key}`));
      const heading = element("h2", "", pr.title);
      heading.id = "detail-title";
      const body = $("detail-body");
      body.replaceChildren(
        badge,
        heading,
        element("div", "mono muted", `${pr.repository}#${pr.number}`),
        element(
          "p",
          "snapshot-details mono",
          `BASE ${pr.baseSha ?? "未知"} · HEAD ${pr.headSha ?? "未知"}`,
        ),
        element("p", "intro", pr.reason),
        textSection("功能价值", pr.value),
        textSection("实现克制", pr.scope),
        textSection("维护代价", pr.cost),
      );
      if (pr.simplifications.length) body.append(listSection("建议精简", pr.simplifications));
      if (pr.questions.length) body.append(listSection("需要回答的问题", pr.questions));
      body.append(textSection("下一步", pr.action));
      const evidence = element("section", "detail-section");
      evidence.append(element("h3", "", "关键证据"));
      for (const item of pr.evidence) {
        const file = element("div", "evidence-file mono");
        file.append(
          item.url ? link(item.label, item.url) : element("span", "", item.label),
          element("small", "", item.detail),
          element("span", "file-revision", `版本 / 来源：${item.revision}`),
        );
        evidence.append(file);
      }
      if (!pr.evidence.length)
        evidence.append(element("p", "muted", "证据尚未取得，具体缺口见理由和待答问题。"));
      const status = textSection("集成参考 · 不是硬阻断", pr.integration.note);
      status.append(
        integration(pr),
        element("small", "muted", `采集于 ${pr.integration.collectedAt}`),
      );
      const actions = element("div", "drawer-actions");
      actions.append(link("打开 PR ↗", pr.url, "button"));
      body.append(
        evidence,
        status,
        actions,
        element(
          "div",
          "detail-note",
          "只展示评估建议，不执行 approve、merge 或评论。链接和结论对应生成时的快照，合入由维护者决定。",
        ),
      );
      $("detail").showModal();
      $("detail").scrollTop = 0;
    }

    function detailButton(pr, className) {
      const button = element("button", className, "评估详情 →");
      button.setAttribute("aria-label", `查看 ${pr.repository}#${pr.number} 评估详情`);
      button.addEventListener("click", () => showDetail(pr));
      return button;
    }

    function card(pr) {
      const node = element("article", "card");
      const meta = element("div", "card-meta");
      meta.append(
        link(`#${pr.number}`, pr.url, "pr-number mono"),
        element("span", "scope-tag", pr.repository),
      );
      const next = element("div", "next");
      next.append(element("span", "next-label", "下一步"), element("span", "next-text", pr.action));
      const value = element("p", "card-value");
      value.append(element("strong", "", "价值 · "), document.createTextNode(pr.value));
      node.append(
        meta,
        element("h3", "", pr.title),
        element("p", "card-reason", pr.reason),
        value,
        next,
      );
      node.append(
        element("p", "snapshot-details mono", `HEAD ${pr.headSha?.slice(0, 8) ?? "未知"}`),
      );
      if ($("show-ci").checked) node.append(integration(pr));
      const footer = element("div", "card-footer");
      const stats = pr.stats
        ? `${pr.stats.files} 文件 · +${pr.stats.additions} / −${pr.stats.deletions}`
        : "改动统计未知";
      footer.append(element("span", "mono", stats), detailButton(pr, "detail-button"));
      node.append(footer);
      return node;
    }

    function renderTable(prs) {
      const table = element("table");
      const head = element("thead");
      const headRow = element("tr");
      const labels = [
        "PR / 仓库",
        "合入建议",
        "评估理由",
        ...($("show-ci").checked ? ["CI / 冲突 · 辅助"] : []),
        "下一步",
        "详情",
      ];
      for (const label of labels) {
        const cell = element("th", "", label);
        cell.scope = "col";
        headRow.append(cell);
      }
      head.append(headRow);
      const body = element("tbody");
      for (const pr of prs) {
        const row = element("tr");
        const identity = element("td");
        identity.append(
          link(`${pr.repository}#${pr.number}`, pr.url, "mono"),
          element("span", "table-title", pr.title),
        );
        const verdict = verdicts.find((item) => item.key === pr.verdict);
        const badge = element("td", verdict.className);
        badge.append(element("span", "verdict-pill", verdict.label));
        row.append(identity, badge, element("td", "", pr.reason));
        if ($("show-ci").checked) {
          const cell = element("td", "table-ci");
          cell.append(integration(pr));
          row.append(cell);
        }
        const action = element("td");
        action.append(detailButton(pr, "table-open"));
        row.append(element("td", "", pr.action), action);
        body.append(row);
      }
      if (!prs.length) {
        const row = element("tr");
        const cell = element("td", "muted", "没有匹配的 PR。");
        cell.colSpan = labels.length;
        row.append(cell);
        body.append(row);
      }
      table.append(head, body);
      $("table-view").replaceChildren(table);
    }

    function render() {
      const query = $("search").value.trim().toLowerCase().replace(/^#/u, "");
      const prs = report.prs
        .filter((pr) => `${pr.repository}#${pr.number} ${pr.title}`.toLowerCase().includes(query))
        .sort((a, b) => {
          const order = a.number - b.number || a.repository.localeCompare(b.repository);
          return $("sort").value === "asc" ? order : -order;
        });
      $("board").replaceChildren();
      for (const verdict of verdicts) {
        const items = prs.filter((pr) => pr.verdict === verdict.key);
        const column = element("section", `column ${verdict.className}`);
        column.setAttribute("aria-label", verdict.label);
        const head = element("div", "column-head");
        const heading = element("h2", "column-label");
        heading.append(element("span", "dot"), document.createTextNode(verdict.label));
        head.append(
          heading,
          element(
            "span",
            "column-count",
            query ? `${items.length} / ${counts[verdict.key]}` : counts[verdict.key],
          ),
          element("span", "column-token mono", verdict.key),
        );
        const list = element("div", "card-list");
        list.append(...items.map(card));
        if (!items.length)
          list.append(element("div", "empty", query ? "没有匹配的 PR" : "此档暂无 PR"));
        column.append(head, element("p", "column-description", verdict.hint), list);
        $("board").append(column);
      }
      renderTable(prs);
      $("board").hidden = view !== "board";
      $("table-view").hidden = view !== "table";
      $("board-tab").setAttribute("aria-pressed", String(view === "board"));
      $("table-tab").setAttribute("aria-pressed", String(view === "table"));
      $("results").textContent =
        `显示 ${prs.length} / ${report.prs.length} 个已评估 PR · CI/冲突不决定所属列`;
    }

    $("report-scope").textContent = `${report.repositories.join(" · ")} — ${report.scope}`;
    $("completeness").textContent = report.complete ? "采集完整 · 只读快照" : "部分结果 · 只读快照";
    if (!report.complete) {
      $("collection-note").hidden = false;
      const errors = element("ul");
      errors.append(...report.errors.map((error) => element("li", "", error)));
      $("collection-note").append(
        element("p", "", "本报告存在以下采集缺口；未取得的 PR 不会被计作已评估："),
        errors,
      );
    }
    const total = element("span", "total");
    total.append(
      document.createTextNode("已评估 "),
      element("strong", "", report.prs.length),
      document.createTextNode(` 个 PR / 跳过 ${report.skipped.length} 个`),
    );
    $("summary").append(total);
    for (const verdict of verdicts) {
      const item = element("span", `summary-item ${verdict.className}`);
      item.append(
        element("span", "dot tone"),
        document.createTextNode(verdict.label),
        element("strong", "", counts[verdict.key]),
      );
      $("summary").append(item);
    }
    $("generated-time").textContent = new Date(report.generatedAt).toLocaleString("zh-CN", {
      hour12: false,
    });
    $("generated-time").dateTime = report.generatedAt;
    $("skipped-summary").textContent = `已跳过 · ${report.skipped.length} 个 PR`;
    if (!report.skipped.length) $("skipped-list").append(element("p", "", "没有跳过的 PR。"));
    for (const pr of report.skipped) {
      const item = element("div", "skipped-item");
      item.append(
        link(`${pr.repository}#${pr.number}`, pr.url, "mono"),
        element("span", "", pr.title),
        element("span", "muted", pr.reason),
      );
      $("skipped-list").append(item);
    }
    for (const repository of report.repositories)
      $("repository-links").append(
        link(`${repository} PR 列表 ↗`, `https://github.com/${repository}/pulls`),
      );
    $("search").addEventListener("input", render);
    $("sort").addEventListener("change", render);
    $("show-ci").addEventListener("change", render);
    $("board-tab").addEventListener("click", () => {
      view = "board";
      render();
    });
    $("table-tab").addEventListener("click", () => {
      view = "table";
      render();
    });
    $("close-detail").addEventListener("click", () => $("detail").close());
    $("detail").addEventListener("click", (event) => {
      if (event.target !== $("detail")) return;
      const rect = $("detail").getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        $("detail").close();
    });
    let toastTimer;
    $("export").disabled = false;
    $("export").addEventListener("click", () => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "codexhost-pr-report.json";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $("toast").textContent = "已导出当前评估快照；未访问 GitHub";
      $("toast").hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        $("toast").hidden = true;
      }, 3200);
    });
    render();
    $("load-notice").hidden = true;
  } catch (error) {
    $("load-notice").hidden = false;
    $("load-notice").textContent =
      `报告无法展示：${error.message}。请检查 JSON 后重新运行渲染脚本。`;
    $("export").disabled = true;
  }
})();

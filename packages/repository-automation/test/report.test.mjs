import { describe, expect, it } from "vitest";
import { activityState, reminder, renderReport } from "../src/report.mjs";
import { reviewEvidence } from "../src/reviews.mjs";
import { COMMENT_MARKER, isMaintenanceComment, readState } from "../src/policy.mjs";
import { bot, ci, comment, data, head, item, now, oldHead, pr } from "./fixtures.mjs";

const render = (overrides = {}) =>
  renderReport({ item: pr(), isPr: true, comments: [], prData: data(), now, ...overrides });

describe("honest revision-bound snapshots", () => {
  it("distinguishes no run, approval required, pending, failure, skipped and success", () => {
    expect(render({ prData: data({ ci: { jobs: [] } }) })).toContain("尚未发现本提交");
    for (const [conclusion, text] of [
      ["action_required", "等待维护者批准"],
      ["failure", "失败"],
      ["skipped", "已跳过"],
      ["success", "工作流报告通过"],
    ]) {
      expect(render({ prData: data({ ci: ci({ conclusion }) }) })).toContain(text);
    }
    expect(render({ prData: data({ ci: ci({ status: "queued", conclusion: null }) }) })).toContain(
      "排队／等待中",
    );
    expect(render({ prData: data({ ci: { ...ci(), jobs: [] } }) })).toContain(
      "四项检查没有全部成功证据",
    );
    expect(render({ prData: data({ ci: { jobs: [], unavailable: true } }) })).toContain(
      "读取失败，不能视为通过",
    );
  });

  it("binds author validation explicitly, rather than blessing a checkbox at the new head", () => {
    expect(render()).toContain("这仍是作者声明");
    expect(render({ item: pr({ body: "## Test plan\nnpm test passed" }) })).toContain(
      "尚未绑定完整提交 SHA",
    );
    expect(render({ item: pr({ body: `## Validated commit\n${oldHead}` }) })).toContain(
      "测试声明绑定旧提交",
    );
    const previous = comment({ user: bot, body: render({ item: pr({ head: { sha: oldHead } }) }) });
    expect(render({ previous })).toContain("HEAD 已变化");
  });

  it("marks old reviews and does not equate lack of bot records with success", () => {
    const reviews = [
      {
        user: { login: "reviewer" },
        submitted_at: "2026-09-09",
        commit_id: oldHead,
        state: "CHANGES_REQUESTED",
      },
    ];
    const report = render({ prData: data({ reviews }) });
    expect(report).toContain("请求修改");
    expect(report).toContain("旧提交 bbbbbbb，需复核");
    expect(report).toContain("未发现可确认的审查记录");
    expect(report).toContain("不会被本工作流撤销");
  });

  it("does not treat a later comment-only review as withdrawing a human change request", () => {
    const original = {
      user: { login: "reviewer", type: "User" },
      submitted_at: "2026-09-08",
      state: "CHANGES_REQUESTED",
      commit_id: oldHead,
    };
    const update = { ...original, submitted_at: "2026-09-09", state: "COMMENTED", commit_id: head };
    expect(reviewEvidence({ reviews: [original, update], comments: [] })[0]).toMatchObject({
      status: "请求修改",
      sha: oldHead,
    });
    expect(
      reviewEvidence({ reviews: [original, { ...update, state: "APPROVED" }], comments: [] })[0],
    ).toMatchObject({ status: "已批准", sha: head });
    expect(
      reviewEvidence({ reviews: [{ ...original, state: "DISMISSED" }, update], comments: [] })[0]
        .status,
    ).toBe("已提交审查意见");
  });

  it("does not claim unknown freeform issues completed a structured information check", () => {
    expect(
      renderReport({ item: item({ body: "It does not work" }), isPr: false, comments: [], now }),
    ).toContain("未识别条目类型");
  });

  it("accepts a Codex summary for its recorded revision, not arbitrary user text", () => {
    const body = `<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** | \`${head.slice(0, 7)}\` | PR opened |`;
    const summary = comment({ body, user: { login: "chatgpt-codex-connector[bot]", type: "Bot" } });
    expect(render({ comments: [summary] })).toContain("机器人报告已完成");
    expect(render({ comments: [comment({ body })] })).not.toContain("机器人报告已完成");
  });

  it("accepts current CodeRabbit coverage but prioritizes a rate-limited header", () => {
    const body = `<!-- final_review_risk_coverage:${JSON.stringify({ coveredCommitId: head, kind: "reviewed" })} -->`;
    const summary = comment({ body, user: { login: "coderabbitai[bot]", type: "Bot" } });
    expect(render({ comments: [summary] })).toContain("机器人报告已完成");
    expect(
      render({ comments: [{ ...summary, body: `> ## Rate limit exceeded\n${body}` }] }),
    ).toContain("审查限流或跳过");
    expect(
      reviewEvidence({
        reviews: [],
        comments: [{ ...summary, body: body.replace('"reviewed"', '"skipped"') }],
      }).find((row) => row.author === "coderabbitai[bot]").sha,
    ).toBeUndefined();
  });

  it("does not mistake quota rejection for a completed review", () => {
    const reviews = [
      {
        user: { login: "copilot-pull-request-reviewer[bot]", type: "Bot" },
        submitted_at: "2026-09-09",
        state: "COMMENTED",
        body: "Copilot was unable to review this pull request because the user reached their quota limit.",
      },
    ];
    expect(reviewEvidence({ reviews, comments: [] })[0].status).toContain("未审查");
    expect(
      reviewEvidence({
        reviews: [{ ...reviews[0], user: { login: "human", type: "User" } }],
        comments: [],
      })[0].status,
    ).toBe("已提交审查意见");
  });

  it("escapes untrusted paths, names and mentions instead of reposting executable markup", () => {
    const malicious = "<img src=x>@team|evil";
    const report = render({
      prData: data({ reviews: [{ user: { login: malicious }, state: "COMMENTED" }] }),
    });
    expect(report).not.toContain("<img");
    expect(report).not.toContain("@team");
    expect(report).toContain("&lt;img");
  });

  it("is idempotent for unchanged data and never accepts forged ownership state", () => {
    expect(render()).toBe(render());
    const fake = comment({ body: render() });
    expect(isMaintenanceComment(fake)).toBe(false);
    expect(readState(fake)).toBeNull();
    expect(readState({ ...fake, user: bot })).toMatchObject({ version: 1, headSha: head });
    expect(
      readState(
        comment({
          user: bot,
          body: `${COMMENT_MARKER}\n<!-- codexhost-maintenance-state:not-json -->`,
        }),
      ),
    ).toBeNull();
  });
});

describe("reminders without auto-close or bot-driven inactivity resets", () => {
  const start = "2026-08-01T12:00:00Z";
  it("does not count its own summary edits as activity", () => {
    const original = item({
      created_at: start,
      updated_at: start,
      labels: [{ name: "awaiting-author" }],
    });
    const previous = comment({
      user: bot,
      body: renderReport({ item: original, isPr: false, comments: [], now }),
      updated_at: "2026-09-09T12:00:00Z",
    });
    const state = activityState({
      item: { ...original, updated_at: previous.updated_at },
      previous,
      comments: [previous],
      now,
    });
    expect(state.lastActivityAt).toBe("2026-08-01T12:00:00.000Z");
    expect(reminder({ labels: original.labels, state, now })).toContain("等待作者 40 天");
    expect(reminder({ labels: [], state, now })).toContain("40 天没有观察到其他活动");
  });
  it("refreshes activity for a reply or an edit after the previous summary", () => {
    const previous = comment({
      user: bot,
      body: renderReport({
        item: item({ created_at: start, updated_at: start }),
        isPr: false,
        comments: [],
        now,
      }),
      updated_at: start,
    });
    const state = activityState({
      item: item(),
      previous,
      comments: [previous, comment({ updated_at: "2026-09-09T15:00:00Z" })],
      now,
    });
    expect(reminder({ labels: [{ name: "awaiting-author" }], state, now })).toBeNull();
  });
  it("requires 14 days waiting for an author or 30 days otherwise", () => {
    const state = { lastActivityAt: new Date(now - 14 * 86400000).toISOString() };
    expect(reminder({ labels: [{ name: "awaiting-author" }], state, now })).toContain("14 天");
    expect(reminder({ labels: [], state, now })).toBeNull();
  });
});

import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  rendererHarnessMessages,
  rendererPermissionModePresentation,
} from "../src/renderer-harness-localization.js";
import {
  isPermissionModeControlReady,
  rendererPermissionModeLabel,
  rendererPermissionModeMenuPlacement,
} from "../src/renderer-permission-mode-picker.js";

const catalog = harnessPermissionModeCatalogSchema.parse({
  modes: [
    {
      id: "plan",
      label: "Plan mode",
      description:
        "Explore and prepare a plan; approval exits planning and resumes the previous permission mode.",
    },
    { id: "default", label: "Default" },
    { id: "bypassPermissions", label: "Bypass permissions", dangerous: true },
  ],
  defaultModeId: "default",
});

describe("Renderer Permission Mode picker presentation", () => {
  it("normalizes menu geometry against the Codex window zoom", () => {
    expect(
      rendererPermissionModeMenuPlacement(
        { left: 800, top: 1_312 },
        { width: 1_920, height: 1_440 },
        1.6,
      ),
    ).toEqual({ width: 320, left: 500, bottom: 86 });
  });

  it("falls back to unscaled menu geometry when the Codex window zoom is unavailable", () => {
    expect(
      rendererPermissionModeMenuPlacement(
        { left: 500, top: 820 },
        { width: 1_200, height: 900 },
        Number.NaN,
      ),
    ).toEqual({ width: 320, left: 500, bottom: 86 });
  });

  it("is ready only for an Adapter-confirmed catalog entry", () => {
    const selected = harnessPermissionModeIdSchema.parse("default");
    expect(isPermissionModeControlReady({ status: "ready", catalog, selected })).toBe(true);
    expect(
      isPermissionModeControlReady({
        status: "ready",
        catalog,
        selected: harnessPermissionModeIdSchema.parse("future"),
      }),
    ).toBe(false);
    expect(isPermissionModeControlReady({ status: "selecting", catalog, selected })).toBe(false);
    expect(isPermissionModeControlReady({ status: "error", catalog, selected })).toBe(true);
    expect(isPermissionModeControlReady({ status: "error", error: "inspection failed" })).toBe(
      false,
    );
  });

  it("treats a structurally unsupported Harness as complete without inventing a mode", () => {
    expect(isPermissionModeControlReady({ status: "unsupported" })).toBe(true);
    expect(rendererPermissionModeLabel({ status: "unsupported" })).toBe("Permissions");
  });

  it("localizes shared permission presentation without changing Adapter catalogs", () => {
    const ompMode = harnessPermissionModeCatalogSchema.parse({
      modes: [
        {
          id: "always-ask",
          label: "Always ask",
          description: "Automatically allow reads and ask before write or execution actions.",
        },
      ],
      defaultModeId: "always-ask",
    }).modes[0];
    if (!ompMode) throw new Error("OMP Permission Mode fixture is unavailable");
    expect(rendererPermissionModePresentation(ompMode, "zh-CN")).toEqual({
      label: "始终询问",
      description: "自动允许读取；写入或执行操作前询问。",
    });

    const grokMode = harnessPermissionModeCatalogSchema.parse({
      modes: [
        {
          id: "always-approve",
          label: "Always approve",
          description: "Approve all tool actions without prompting.",
          dangerous: true,
        },
      ],
      defaultModeId: "always-approve",
    }).modes[0];
    if (!grokMode) throw new Error("Grok Permission Mode fixture is unavailable");
    expect(rendererPermissionModePresentation(grokMode, "zh-CN")).toEqual({
      label: "始终批准",
      description: "无需提示即可批准所有工具操作。",
    });

    const plan = catalog.modes[0];
    if (!plan) throw new Error("Plan mode fixture is unavailable");
    expect(rendererPermissionModePresentation(plan, "zh-CN")).toEqual({
      label: "规划模式",
      description: "探索并制定计划；批准计划后退出规划，恢复此前的权限模式。",
    });
    expect(rendererPermissionModePresentation(plan, "en")).toEqual({
      label: "Plan mode",
      description:
        "Explore and prepare a plan; approval exits planning and resumes the previous permission mode.",
    });
    expect(plan.label).toBe("Plan mode");

    const customMode = harnessPermissionModeCatalogSchema.parse({
      modes: [{ id: "custom", label: "Custom policy", description: "Provider-owned policy." }],
      defaultModeId: "custom",
    }).modes[0];
    if (!customMode) throw new Error("Custom Permission Mode fixture is unavailable");
    expect(rendererPermissionModePresentation(customMode, "zh-CN")).toEqual({
      label: "Custom policy",
      description: "Provider-owned policy.",
    });
  });

  it.each([
    {
      harness: "OpenCode",
      id: "default",
      nativeLabel: "Default",
      en: "Default",
      zh: "默认",
      description: "Use OpenCode's configured permission rules.",
      zhDescription: "使用 OpenCode 已配置的权限规则。",
    },
    {
      harness: "OpenCode",
      id: "ask",
      nativeLabel: "Ask",
      en: "Ask",
      zh: "询问",
      description: "Ask before protected OpenCode actions.",
      zhDescription: "执行受保护的 OpenCode 操作前询问。",
    },
    {
      harness: "OpenCode",
      id: "allow",
      nativeLabel: "Allow all",
      en: "Allow all",
      zh: "全部允许",
      description: "Allow OpenCode actions without approval prompts.",
      zhDescription: "允许 OpenCode 操作，无需批准提示。",
    },
    {
      harness: "DSH",
      id: "read-only",
      nativeLabel: "read-only",
      en: "Read only",
      zh: "只读",
      description: undefined,
      zhDescription: undefined,
    },
    {
      harness: "DSH",
      id: "read-only",
      nativeLabel: "Read only",
      en: "Read only",
      zh: "只读",
      description: undefined,
      zhDescription: undefined,
    },
    {
      harness: "DSH",
      id: "workspace-write",
      nativeLabel: "workspace-write",
      en: "Workspace write",
      zh: "工作区写入",
      description: undefined,
      zhDescription: undefined,
    },
    {
      harness: "DSH",
      id: "danger-full-access",
      nativeLabel: "danger-full-access",
      en: "Full access (dangerous)",
      zh: "完全访问（危险）",
      description: undefined,
      zhDescription: undefined,
    },
    {
      harness: "AGY",
      id: "configured",
      nativeLabel: "Configured permissions",
      en: "Configured permissions",
      zh: "使用已配置权限",
      description: "Use Antigravity CLI permission rules; headless prompts are denied safely.",
      zhDescription: "使用 Antigravity CLI 权限规则；无界面运行时安全拒绝需要交互确认的请求。",
    },
    {
      harness: "AGY",
      id: "dangerously-skip-permissions",
      nativeLabel: "Skip permissions",
      en: "Skip permissions",
      zh: "跳过权限检查",
      description: "Auto-approve every Antigravity CLI tool action.",
      zhDescription: "自动批准所有 Antigravity CLI 工具操作。",
    },
    {
      harness: "CodeBuddy",
      id: "default",
      nativeLabel: "Always Ask",
      en: "Always Ask",
      zh: "始终询问",
      description: "Prompts for permission on first use of each tool",
      zhDescription: "首次使用每种工具时请求权限。",
    },
    {
      harness: "CodeBuddy",
      id: "acceptEdits",
      nativeLabel: "Accept Edits",
      en: "Accept Edits",
      zh: "接受编辑",
      description: "Automatically accepts file edit permissions for the session",
      zhDescription: "自动接受本会话中的文件编辑权限。",
    },
    {
      harness: "CodeBuddy",
      id: "plan",
      nativeLabel: "Plan",
      en: "Plan",
      zh: "规划模式",
      description: "Agent can analyze but not modify files or execute commands",
      zhDescription: "Agent 可以分析，但不能修改文件或执行命令。",
    },
    {
      harness: "CodeBuddy",
      id: "auto",
      nativeLabel: "Auto",
      en: "Auto",
      zh: "自动",
      description:
        "An AI classifier reviews actions that would normally prompt: safe ones are auto-approved, risky ones are denied. If the classifier is unavailable, the action falls back to a prompt (or is denied when prompts cannot be shown)",
      zhDescription:
        "由 AI 分类器评估原本需要询问的操作：安全操作自动批准，风险操作拒绝。分类器不可用时改为询问；无法显示询问时拒绝。",
    },
    {
      harness: "CodeBuddy",
      id: "dontAsk",
      nativeLabel: "Don't Ask",
      en: "Don't Ask",
      zh: "不询问",
      description:
        "Does not show permission prompts; pre-approved and safe read-only actions run, everything else that would prompt is denied",
      zhDescription:
        "不显示权限询问；已获批准和安全的只读操作可以执行，其余原本需要询问的操作会被拒绝。",
    },
    {
      harness: "CodeBuddy",
      id: "bypassPermissions",
      nativeLabel: "Bypass Permissions",
      en: "Bypass Permissions",
      zh: "绕过权限",
      description: "Skips all permission prompts",
      zhDescription: "跳过常规权限询问。",
      dangerous: true,
    },
    {
      harness: "CodeBuddy",
      id: "fullAccess",
      nativeLabel: "Full Access",
      en: "Full Access",
      zh: "完全访问",
      description: "Skips ALL permission checks including dangerous commands for all agents",
      zhDescription: "为所有 Agent 跳过全部权限检查，包括危险命令。",
      dangerous: true,
    },
    {
      harness: "CodeBuddy",
      id: "delegate",
      nativeLabel: "Delegate",
      en: "Delegate",
      zh: "由父会话管理",
      description: "Permissions managed by parent session",
      zhDescription: "由父会话管理权限。",
    },
  ])(
    "localizes $harness $nativeLabel in both the menu and selected control",
    ({ id, nativeLabel, en, zh, description, zhDescription, dangerous }) => {
      const modeCatalog = harnessPermissionModeCatalogSchema.parse({
        modes: [
          {
            id,
            label: nativeLabel,
            ...(description ? { description } : {}),
            ...(dangerous ? { dangerous } : {}),
          },
        ],
        defaultModeId: id,
      });
      const mode = modeCatalog.modes[0];
      if (!mode) throw new Error("Permission Mode fixture is unavailable");
      const original = { ...mode };
      expect(rendererPermissionModePresentation(mode, "zh-CN")).toEqual({
        label: zh,
        description: zhDescription,
      });
      expect(rendererPermissionModePresentation(mode, "en")).toEqual({ label: en, description });
      const view = { status: "ready" as const, catalog: modeCatalog, selected: mode.id };
      expect(rendererPermissionModeLabel(view, "zh-CN")).toBe(zh);
      expect(rendererPermissionModeLabel(view, "en")).toBe(en);
      expect(mode).toEqual(original);
    },
  );

  it("preserves unknown native wording even when the permission ID is familiar", () => {
    const modeCatalog = harnessPermissionModeCatalogSchema.parse({
      modes: [
        {
          id: "fullAccess",
          label: "Future access policy",
          description: "Policy supplied by a newer CLI.",
          dangerous: true,
        },
      ],
      defaultModeId: "fullAccess",
    });
    const mode = modeCatalog.modes[0];
    if (!mode) throw new Error("Permission Mode fixture is unavailable");
    const original = structuredClone(modeCatalog);
    expect(rendererPermissionModePresentation(mode, "zh-CN")).toEqual({
      label: "Future access policy",
      description: "Policy supplied by a newer CLI.",
    });
    expect(
      rendererPermissionModeLabel(
        { status: "ready", catalog: modeCatalog, selected: mode.id },
        "zh-CN",
      ),
    ).toBe("Future access policy");
    expect(modeCatalog).toEqual(original);
  });

  it("uses localized stable pending/error labels", () => {
    expect(
      rendererPermissionModeLabel({
        status: "ready",
        catalog,
        selected: harnessPermissionModeIdSchema.parse("plan"),
      }),
    ).toBe("Plan mode");
    expect(rendererPermissionModeLabel({ status: "loading" })).toBe("Loading permissions...");
    expect(rendererPermissionModeLabel({ status: "loading" }, "zh-CN")).toBe("正在加载权限...");
    expect(rendererPermissionModeLabel({ status: "error", error: "offline" }, "zh-CN")).toBe(
      "权限不可用",
    );
  });

  it("keeps the current mode label when selection is locked at create", () => {
    const selected = harnessPermissionModeIdSchema.parse("default");
    expect(
      rendererPermissionModeLabel({
        status: "ready",
        catalog,
        selected,
        selectionLocked: true,
        selectionLockedReason: rendererHarnessMessages("en").permissionModeFixedAtCreate,
      }),
    ).toBe("Default");
    expect(rendererHarnessMessages("en").permissionModeFixedAtCreate).toBe(
      "Grok fixes its Permission Mode when the Session is created. Start a new Thread to change it.",
    );
    expect(rendererHarnessMessages("zh-CN").permissionModeFixedAtCreate).toBe(
      "Grok 的权限模式在会话创建时确定，如需更改请新建会话",
    );
  });
});

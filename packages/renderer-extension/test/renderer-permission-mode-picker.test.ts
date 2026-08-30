import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { rendererPermissionModePresentation } from "../src/renderer-harness-localization.js";
import {
  isPermissionModeControlReady,
  rendererPermissionModeLabel,
} from "../src/renderer-permission-mode-picker.js";

const catalog = harnessPermissionModeCatalogSchema.parse({
  modes: [
    {
      id: "plan",
      label: "Plan mode",
      description: "Analyze and plan without executing tools.",
    },
    { id: "default", label: "Default" },
    { id: "bypassPermissions", label: "Bypass permissions", dangerous: true },
  ],
  defaultModeId: "default",
});

describe("Renderer Permission Mode picker presentation", () => {
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
      description: "仅分析和规划，不执行工具。",
    });
    expect(rendererPermissionModePresentation(plan, "en")).toEqual({
      label: "Plan mode",
      description: "Analyze and plan without executing tools.",
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
});

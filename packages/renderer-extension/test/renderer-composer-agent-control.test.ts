import {
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "@codexhost/shared-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  renderComposerAgentControl,
  type ComposerAgentControl,
} from "../src/renderer-composer-dom.js";
import { renderRendererModelPicker } from "../src/renderer-model-picker.js";
import { renderRendererPermissionModePicker } from "../src/renderer-permission-mode-picker.js";
import { renderRendererUsageControl } from "../src/renderer-usage-control.js";
import { renderRendererCreditsControl } from "../src/renderer-credits-control.js";
import type * as RendererAgentPicker from "../src/renderer-agent-picker.js";
import type * as RendererModelPicker from "../src/renderer-model-picker.js";
import type * as RendererPermissionModePicker from "../src/renderer-permission-mode-picker.js";
import type * as RendererUsageControl from "../src/renderer-usage-control.js";
import type * as RendererCreditsControl from "../src/renderer-credits-control.js";

vi.mock("../src/renderer-agent-picker.js", async (importOriginal) => {
  const original = await importOriginal<typeof RendererAgentPicker>();
  return {
    ...original,
    renderRendererAgentPicker: vi.fn(() => ({ nativeModelHidden: false })),
  };
});
vi.mock("../src/renderer-model-picker.js", async (importOriginal) => {
  const original = await importOriginal<typeof RendererModelPicker>();
  return { ...original, renderRendererModelPicker: vi.fn() };
});
vi.mock("../src/renderer-permission-mode-picker.js", async (importOriginal) => {
  const original = await importOriginal<typeof RendererPermissionModePicker>();
  return { ...original, renderRendererPermissionModePicker: vi.fn() };
});
vi.mock("../src/renderer-usage-control.js", async (importOriginal) => {
  const original = await importOriginal<typeof RendererUsageControl>();
  return { ...original, renderRendererUsageControl: vi.fn() };
});
vi.mock("../src/renderer-credits-control.js", async (importOriginal) => {
  const original = await importOriginal<typeof RendererCreditsControl>();
  return { ...original, renderRendererCreditsControl: vi.fn() };
});

/** A verified native Permission-mode trigger so the picker can be shown at all. */
function verifiedPermissionButton(parent: HTMLElement): HTMLElement {
  const attributes = new Map<string, string>([
    ["aria-haspopup", "menu"],
    ["data-composer-navigation-target", "permissions"],
  ]);
  const fiber = {
    memoizedProps: {
      "data-composer-navigation-target": "permissions",
      "aria-haspopup": "menu",
    },
    return: {
      memoizedProps: {
        showPermissionsModeDropdown: true,
        permissionsHostId: "local",
        permissionsCwdOverride: null,
      },
      return: null,
    },
  };
  const element = {
    hidden: false,
    parentElement: parent,
    style: {} as Record<string, string>,
    click: vi.fn(),
    contains: () => false,
    hasAttribute: (name: string) => attributes.has(name),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    matches: (selector: string) => selector.includes('aria-haspopup="menu"'),
  };
  Object.defineProperty(element, "__reactFiber$test", { value: fiber });
  return element as unknown as HTMLElement;
}

function fakeControl(): {
  control: ComposerAgentControl;
  harnessRoot: { hidden: boolean; style: Record<string, string> };
  harnessClose: ReturnType<typeof vi.fn>;
} {
  const permParent = { insertBefore: vi.fn() } as unknown as HTMLElement;
  const permButton = verifiedPermissionButton(permParent);
  const composer = {
    isConnected: true,
    contains: () => true,
    querySelectorAll: (selector: string) => (selector.includes("button") ? [permButton] : []),
  } as unknown as Element;
  const permissionRoot = {
    parentElement: permParent,
    nextElementSibling: permButton,
    style: {} as Record<string, string>,
  };
  const harnessRoot = { hidden: false, style: {} as Record<string, string> };
  const harnessClose = vi.fn();
  const control = {
    composer,
    composerId: "composer-1",
    root: { parentElement: null, remove: vi.fn() },
    picker: { root: { parentElement: null } },
    modelPicker: {
      root: { parentElement: {} as unknown as HTMLElement, style: {} },
      trigger: { style: {}, className: "" },
    },
    permissionModePicker: {
      root: permissionRoot,
      trigger: { style: {}, className: "" },
    },
    nativeModelControl: null,
    nativePermissionModeControl: null,
    nativeContextUsageControl: null,
    nativePermissionModeControlVerified: false,
    credits: { anchor: null, place: vi.fn(), root: { remove: vi.fn() } },
    usage: { anchor: null, place: vi.fn(), root: { remove: vi.fn(), parentElement: null } },
    harnessCommands: {
      root: harnessRoot,
      close: harnessClose,
      setLocale: vi.fn(),
      placeBefore: vi.fn(),
    },
    sendButton: { type: "submit", disabled: false, isConnected: true, parentElement: null },
    sendDisabledBeforeSwitch: null,
  } as unknown as ComposerAgentControl;
  return { control, harnessRoot, harnessClose };
}

const selectedModel = harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" });
const modelView = {
  status: "ready" as const,
  catalog: { models: [{ ref: selectedModel, label: "Sonnet" }], thinkingOptions: [] },
  selected: selectedModel,
  thinkingSelectionSupported: false as const,
};
const permissionModeView = {
  status: "ready" as const,
  catalog: harnessPermissionModeCatalogSchema.parse({
    modes: [{ id: "bypassPermissions", label: "Bypass" }],
    defaultModeId: "bypassPermissions",
  }),
  selected: harnessPermissionModeIdSchema.parse("bypassPermissions"),
};

describe("renderComposerAgentControl read-only subagent thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides the interactive chips for a subagent child thread", () => {
    const { control, harnessRoot, harnessClose } = fakeControl();

    renderComposerAgentControl(
      control,
      { agent: "claude-code", phase: "locked", subagentThread: true },
      "ready",
      false,
      {},
      modelView,
      permissionModeView,
      null,
      null,
      "en",
    );

    expect(vi.mocked(renderRendererModelPicker).mock.calls.at(-1)?.[2]).toBe(false);
    expect(vi.mocked(renderRendererPermissionModePicker).mock.calls.at(-1)?.[2]).toBe(false);
    expect(harnessRoot.hidden).toBe(true);
    expect(harnessRoot.style.display).toBe("none");
    expect(harnessClose).toHaveBeenCalledOnce();
    // The Agent picker (icon) still renders.
    expect(control.picker).toBeDefined();
  });

  it("shows the interactive chips for a normal external thread", () => {
    const { control, harnessRoot, harnessClose } = fakeControl();

    renderComposerAgentControl(
      control,
      { agent: "claude-code", phase: "locked", subagentThread: false },
      "ready",
      false,
      {},
      modelView,
      permissionModeView,
      null,
      null,
      "en",
    );

    expect(vi.mocked(renderRendererModelPicker).mock.calls.at(-1)?.[2]).toBe(true);
    expect(vi.mocked(renderRendererPermissionModePicker).mock.calls.at(-1)?.[2]).toBe(true);
    expect(harnessRoot.hidden).toBe(false);
    expect(harnessRoot.style.display).toBe("inline-flex");
    expect(harnessClose).not.toHaveBeenCalled();
  });

  it("keeps the Usage and Credits displays for a subagent thread", () => {
    const { control } = fakeControl();

    renderComposerAgentControl(
      control,
      { agent: "claude-code", phase: "locked", subagentThread: true },
      "ready",
      false,
      {},
      modelView,
      permissionModeView,
      null,
      null,
      "en",
    );

    expect(renderRendererUsageControl).toHaveBeenCalledOnce();
    expect(renderRendererCreditsControl).toHaveBeenCalledOnce();
  });
});

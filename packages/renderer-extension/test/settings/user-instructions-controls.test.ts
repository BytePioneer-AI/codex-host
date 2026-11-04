import { describe, expect, it, vi } from "vitest";
import { harnessPluginIdSchema } from "@codexhost/shared-contracts";
import type { RendererSettingsPageMountContext } from "../../src/settings/core.js";
import type { LoadedSessionsClient } from "../../src/settings/loaded-sessions-table.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { mountUserInstructionsControls } from "../../src/settings/user-instructions-controls.js";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => ({ classList: { add() {} } }),
  isRendererSettingsIconName: () => true,
}));

class FakeElement {
  readonly children: unknown[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly #listeners = new Map<string, (event?: unknown) => void>();
  id = "";
  htmlFor = "";
  className = "";
  hidden = false;
  textContent = "";
  type = "";
  checked = false;
  disabled = false;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  addEventListener(name: string, listener: (event?: unknown) => void): void {
    this.#listeners.set(name, listener);
  }

  append(...children: unknown[]): void {
    this.children.push(...children);
  }

  dispatch(name: string, event?: unknown): void {
    this.#listeners.get(name)?.(event);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  replaceChildren(...children: unknown[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeDocument {
  readonly defaultView = {} as unknown as Window;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

describe("User instructions settings controls", () => {
  it("loads user instructions settings and updates master and per-CLI switches", async () => {
    const document = new FakeDocument();
    const content = document.createElement("div");
    const controller = new AbortController();
    const context: RendererSettingsPageMountContext = {
      content: content as unknown as HTMLElement,
      signal: controller.signal,
      runLatest: async (task, handlers) => {
        try {
          const value = await task(controller.signal);
          handlers.success(value);
        } catch (error) {
          handlers.failure?.(error);
        }
      },
    };

    let state = {
      enabled: false,
      sourcePath: "~/.codex/AGENTS.md",
      harnesses: [
        {
          harnessId: harnessPluginIdSchema.parse("antigravity"),
          enabled: true,
          targetPath: "~/.gemini/GEMINI.md",
        },
        {
          harnessId: harnessPluginIdSchema.parse("claude-code"),
          enabled: true,
          targetPath: "~/.claude/CLAUDE.md",
        },
      ],
    };

    const client: LoadedSessionsClient = {
      getHarnessUserInstructionsSettings: vi.fn(async () => state),
      setHarnessUserInstructionsSettings: vi.fn(async (input) => {
        const disabled = new Set(input.disabledHarnesses ?? []);
        state = {
          ...state,
          enabled: input.enabled,
          harnesses: state.harnesses.map((entry) => ({
            ...entry,
            enabled: !disabled.has(entry.harnessId),
          })),
        };
        return state;
      }),
    };

    const dispose = mountUserInstructionsControls(
      context,
      rendererSettingsMessages("en"),
      () => client,
    );

    await vi.waitFor(() => {
      expect(client.getHarnessUserInstructionsSettings).toHaveBeenCalledTimes(1);
    });

    const masterSwitch = descendants(content).find(
      (element) =>
        element.getAttribute("role") === "switch" &&
        element.id.startsWith("codexhost-user-instructions-enabled-"),
    );
    expect(masterSwitch).toBeDefined();
    expect(masterSwitch?.checked).toBe(false);

    if (!masterSwitch) throw new Error("Master switch not found");
    masterSwitch.checked = true;
    masterSwitch.dispatch("change");

    await vi.waitFor(() => {
      expect(client.setHarnessUserInstructionsSettings).toHaveBeenCalledWith({
        enabled: true,
        disabledHarnesses: [],
      });
    });

    const claudeSwitch = descendants(content).find(
      (element) => element.dataset.userInstructionsHarness === "claude-code",
    );
    expect(claudeSwitch).toBeDefined();
    expect(claudeSwitch?.checked).toBe(true);

    if (!claudeSwitch) throw new Error("Claude switch not found");
    claudeSwitch.checked = false;
    claudeSwitch.dispatch("change");

    await vi.waitFor(() => {
      expect(client.setHarnessUserInstructionsSettings).toHaveBeenLastCalledWith({
        enabled: true,
        disabledHarnesses: ["claude-code"],
      });
    });

    dispose();
  });
});

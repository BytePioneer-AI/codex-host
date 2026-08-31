import { describe, expect, it } from "vitest";

import { isNativeModelControlCandidate } from "../src/renderer-composer-dom.js";
import {
  rendererAgentMenuPlacement,
  rendererAgentPickerView,
} from "../src/renderer-agent-picker.js";

describe("Renderer Agent picker presentation", () => {
  it("normalizes viewport coordinates against the Codex window zoom", () => {
    expect(
      rendererAgentMenuPlacement(
        { right: 1_440, top: 1_312 },
        { width: 1_920, height: 1_440 },
        1.6,
      ),
    ).toEqual({ left: 700, bottom: 86 });
  });

  it("falls back to unscaled positioning when the Codex window zoom is unavailable", () => {
    expect(
      rendererAgentMenuPlacement(
        { right: 900, top: 820 },
        { width: 1_200, height: 900 },
        Number.NaN,
      ),
    ).toEqual({ left: 700, bottom: 86 });
  });

  it("keeps a Codex draft switchable while disabling unavailable external Agents", () => {
    expect(
      rendererAgentPickerView({ agent: "codex", phase: "draft" }, "unsupported", false, [
        "codex",
        "pi",
        "claude-code",
        "grok",
      ]),
    ).toEqual({
      label: "Codex",
      triggerDisabled: false,
      nativeModelHidden: false,
      optionDisabled: { codex: false, pi: true, "claude-code": true, grok: true },
      downloadVisible: { pi: false, "claude-code": false, grok: false },
    });
  });

  it("hides the native Model for an external Agent and locks submitted selection", () => {
    expect(
      rendererAgentPickerView({ agent: "pi", phase: "locked" }, "ready", false, ["codex", "pi"], {
        pi: "ready",
      }),
    ).toEqual({
      label: "Pi",
      triggerDisabled: true,
      nativeModelHidden: true,
      optionDisabled: { codex: true, pi: true },
      downloadVisible: { pi: false },
    });
  });

  it("hides the native Model and disables all choices while switching", () => {
    expect(
      rendererAgentPickerView({ agent: "codex", phase: "draft" }, "ready", true, ["codex", "pi"]),
    ).toMatchObject({
      triggerDisabled: true,
      nativeModelHidden: true,
      optionDisabled: { codex: true, pi: true },
      downloadVisible: { pi: false },
    });
  });

  it("disables an uninstalled external Agent and exposes its install action", () => {
    expect(
      rendererAgentPickerView({ agent: "codex", phase: "draft" }, "ready", false, ["codex", "pi"], {
        pi: "notInstalled",
      }),
    ).toEqual({
      label: "Codex",
      triggerDisabled: false,
      nativeModelHidden: false,
      optionDisabled: { codex: false, pi: true },
      downloadVisible: { pi: true },
    });
  });

  it("recognizes only the native React Model menu as the Model candidate", () => {
    const element = (
      ownAttributes: readonly string[],
      matches: boolean,
      modelProps: boolean,
      attributes: Readonly<Record<string, string>> = {},
    ) => {
      const candidate = {
        getAttribute: (name: string) => attributes[name] ?? null,
        hasAttribute: (name: string) => ownAttributes.includes(name) || name in attributes,
        matches: () => matches,
      } as unknown as Element;
      Object.defineProperty(candidate, "__reactFiber$test", {
        value: {
          memoizedProps: modelProps
            ? {
                onSelectModel: () => undefined,
                onSelectReasoningEffort: () => undefined,
                reasoningEffort: "medium",
                fallbackPowerSelection: {},
              }
            : {},
        },
      });
      return candidate;
    };

    expect(isNativeModelControlCandidate(element([], true, true))).toBe(true);
    expect(
      isNativeModelControlCandidate(
        element([], true, false, {
          "data-codex-intelligence-trigger": "true",
          "data-composer-navigation-target": "reasoning",
        }),
      ),
    ).toBe(true);
    expect(isNativeModelControlCandidate(element([], true, false))).toBe(false);
    expect(isNativeModelControlCandidate(element([], false, true))).toBe(false);
    expect(
      isNativeModelControlCandidate(element(["data-codexhost-agent-control"], true, true)),
    ).toBe(false);
  });
});

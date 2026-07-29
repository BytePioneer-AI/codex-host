import { describe, expect, it } from "vitest";

import { isNativeModelControlCandidate } from "../src/renderer-composer-dom.js";
import { rendererAgentPickerView } from "../src/renderer-agent-picker.js";

describe("Renderer Agent picker presentation", () => {
  it("keeps a Codex draft switchable while disabling unavailable external Agents", () => {
    expect(
      rendererAgentPickerView({ agent: "codex", phase: "draft" }, "unsupported", false, [
        "codex",
        "pi",
        "claude-code",
      ]),
    ).toEqual({
      label: "Codex",
      triggerDisabled: false,
      nativeModelHidden: false,
      optionDisabled: { codex: false, pi: true, "claude-code": true },
    });
  });

  it("hides the native Model for an external Agent and locks submitted selection", () => {
    expect(
      rendererAgentPickerView({ agent: "pi", phase: "locked" }, "ready", false, ["codex", "pi"]),
    ).toEqual({
      label: "Pi",
      triggerDisabled: true,
      nativeModelHidden: true,
      optionDisabled: { codex: true, pi: true },
    });
  });

  it("hides the native Model and disables all choices while switching", () => {
    expect(
      rendererAgentPickerView({ agent: "codex", phase: "draft" }, "ready", true, ["codex", "pi"]),
    ).toMatchObject({
      triggerDisabled: true,
      nativeModelHidden: true,
      optionDisabled: { codex: true, pi: true },
    });
  });

  it("recognizes only the native React Model menu as the Model candidate", () => {
    const element = (ownAttributes: readonly string[], matches: boolean, modelProps: boolean) => {
      const candidate = {
        hasAttribute: (name: string) => ownAttributes.includes(name),
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
    expect(isNativeModelControlCandidate(element([], true, false))).toBe(false);
    expect(isNativeModelControlCandidate(element([], false, true))).toBe(false);
    expect(
      isNativeModelControlCandidate(element(["data-codexhost-agent-control"], true, true)),
    ).toBe(false);
  });
});

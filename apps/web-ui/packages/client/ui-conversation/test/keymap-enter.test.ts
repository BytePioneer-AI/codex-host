import { createEditor, KEY_ENTER_COMMAND } from "lexical";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArbitrateOutcome } from "../src/client/contract/draft-editor.ts";
import {
  registerComposerKeymap,
  type ComposerKeymapHandlers,
} from "../src/client/input/editor/keymap.ts";

function stubPointerCoarse(coarse: boolean): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: query === "(pointer: coarse)" && coarse,
    }),
  });
}

function createEnterEvent(overrides: Partial<KeyboardEvent> = {}): {
  event: KeyboardEvent;
  preventDefault: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  const event = {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 13,
    getModifierState: () => false,
    preventDefault,
    ...overrides,
  } as unknown as KeyboardEvent;
  return { event, preventDefault };
}

function createHandlers(arbitrateOutcome: ArbitrateOutcome = "pass"): {
  handlers: ComposerKeymapHandlers;
  submit: ReturnType<typeof vi.fn>;
  arbitrate: ReturnType<typeof vi.fn>;
} {
  const submit = vi.fn();
  const arbitrate = vi.fn(() => arbitrateOutcome);
  return {
    handlers: {
      arbitrate,
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit,
      intakeFiles: () => {},
      pasteText: () => {},
    },
    submit,
    arbitrate,
  };
}

describe("registerComposerKeymap Enter behavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<{
    label: string;
    coarse: boolean;
    eventOverrides?: Partial<KeyboardEvent>;
    arbitrateOutcome?: ArbitrateOutcome;
    expectedHandled: boolean;
    expectedPrevented: boolean;
    expectedSubmitArgs: [boolean] | null;
  }>([
    {
      label: "coarse pointer plain Enter falls through to line break",
      coarse: true,
      expectedHandled: false,
      expectedPrevented: false,
      expectedSubmitArgs: null,
    },
    {
      label: "coarse pointer Ctrl+Enter submits accelerated",
      coarse: true,
      eventOverrides: { ctrlKey: true },
      expectedHandled: true,
      expectedPrevented: true,
      expectedSubmitArgs: [true],
    },
    {
      label: "coarse pointer Cmd+Enter submits accelerated",
      coarse: true,
      eventOverrides: { metaKey: true },
      expectedHandled: true,
      expectedPrevented: true,
      expectedSubmitArgs: [true],
    },
    {
      label: "fine pointer plain Enter submits",
      coarse: false,
      expectedHandled: true,
      expectedPrevented: true,
      expectedSubmitArgs: [false],
    },
    {
      label: "coarse pointer IME composition Enter is left to browser",
      coarse: true,
      eventOverrides: { isComposing: true },
      expectedHandled: true,
      expectedPrevented: false,
      expectedSubmitArgs: null,
    },
    {
      label: "fine pointer IME composition Enter is left to browser",
      coarse: false,
      eventOverrides: { isComposing: true },
      expectedHandled: true,
      expectedPrevented: false,
      expectedSubmitArgs: null,
    },
    {
      label: "coarse pointer menu arbitration consumes Enter",
      coarse: true,
      arbitrateOutcome: "pick-highlighted",
      expectedHandled: true,
      expectedPrevented: true,
      expectedSubmitArgs: null,
    },
    {
      label: "fine pointer menu arbitration consumes Enter",
      coarse: false,
      arbitrateOutcome: "pick-highlighted",
      expectedHandled: true,
      expectedPrevented: true,
      expectedSubmitArgs: null,
    },
  ])(
    "$label",
    ({
      coarse,
      eventOverrides,
      arbitrateOutcome,
      expectedHandled,
      expectedPrevented,
      expectedSubmitArgs,
    }) => {
      stubPointerCoarse(coarse);
      const editor = createEditor({
        namespace: "test-composer-keymap",
        onError: (error) => {
          throw error;
        },
      });
      const { handlers, submit, arbitrate } = createHandlers(arbitrateOutcome);
      const unregister = registerComposerKeymap(editor, handlers);

      try {
        const { event, preventDefault } = createEnterEvent(eventOverrides);
        const handled = editor.dispatchCommand(KEY_ENTER_COMMAND, event);

        expect(handled).toBe(expectedHandled);
        expect(preventDefault).toHaveBeenCalledTimes(expectedPrevented ? 1 : 0);
        if (expectedSubmitArgs === null) {
          expect(submit).not.toHaveBeenCalled();
        } else {
          expect(submit).toHaveBeenCalledTimes(1);
          expect(submit).toHaveBeenCalledWith(...expectedSubmitArgs);
        }
        if (arbitrateOutcome !== undefined) {
          expect(arbitrate).toHaveBeenCalledWith("enter", false);
        }
      } finally {
        unregister();
      }
    },
  );
});

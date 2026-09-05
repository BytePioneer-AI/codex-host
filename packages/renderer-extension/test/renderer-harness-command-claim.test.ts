import type { HarnessCommandDescriptor } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { routeRendererHarnessCommandSelection } from "../src/renderer-harness-command-claim.js";

const textCommand = {
  id: "dsh.goal",
  invocation: "/dsh-goal",
  label: "Goal",
  argumentMode: "text",
} as HarnessCommandDescriptor;

const noneCommand = {
  id: "dsh.compact",
  invocation: "/compact",
  label: "Compact",
  argumentMode: "none",
} as HarnessCommandDescriptor;

class FakeInputEvent {
  constructor(
    readonly type: string,
    readonly init: Record<string, unknown>,
  ) {}
}

class FakeTextarea {
  #value = "keep this draft";
  selectionStart: number | null = 5;
  selectionEnd: number | null = 9;
  readonly events: FakeInputEvent[] = [];
  readonly focus = vi.fn();
  readonly setSelectionRange = vi.fn();
  readonly ownerDocument = {
    defaultView: {
      HTMLTextAreaElement: FakeTextarea,
      InputEvent: FakeInputEvent,
    },
  };

  get value(): string {
    return this.#value;
  }

  set value(value: string) {
    this.#value = value;
  }

  dispatchEvent(event: FakeInputEvent): boolean {
    this.events.push(event);
    return true;
  }
}

describe("Renderer Harness command Composer claims", () => {
  it("prefixes a textarea draft and leaves execution to the normal submit path", () => {
    const editor = new FakeTextarea();
    const execute = vi.fn();

    expect(
      routeRendererHarnessCommandSelection(editor as unknown as HTMLElement, textCommand, execute),
    ).toBe(true);
    expect(editor.value).toBe("/dsh-goal keep this draft");
    expect(editor.events).toHaveLength(1);
    expect(editor.events[0]).toMatchObject({
      type: "input",
      init: { bubbles: true, data: "/dsh-goal ", inputType: "insertText" },
    });
    expect(editor.setSelectionRange).toHaveBeenCalledWith(15, 19);
    expect(editor.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses Chromium insertText for a Lexical contenteditable without replacing its draft", () => {
    const range = {
      selectNodeContents: vi.fn(),
      collapse: vi.fn(),
    };
    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    const editor = {
      textContent: "existing rich draft",
      getAttribute: (name: string) => (name === "contenteditable" ? "true" : null),
      focus: vi.fn(),
    };
    const execCommand = vi.fn((_command: string, _showUi: boolean, prefix: string) => {
      editor.textContent = prefix + editor.textContent;
      return true;
    });
    Object.assign(editor, {
      ownerDocument: {
        defaultView: { HTMLTextAreaElement: FakeTextarea },
        createRange: () => range,
        execCommand,
        getSelection: () => selection,
      },
    });
    const execute = vi.fn();

    expect(
      routeRendererHarnessCommandSelection(editor as unknown as HTMLElement, textCommand, execute),
    ).toBe(true);
    expect(range.selectNodeContents).toHaveBeenCalledWith(editor);
    expect(range.collapse).toHaveBeenCalledWith(true);
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "/dsh-goal ");
    expect(editor.textContent).toBe("/dsh-goal existing rich draft");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when contenteditable insertion is unavailable", () => {
    const editor = {
      textContent: "keep this draft",
      getAttribute: () => "true",
      focus: vi.fn(),
      ownerDocument: {
        defaultView: { HTMLTextAreaElement: FakeTextarea },
        createRange: () => ({ selectNodeContents: vi.fn(), collapse: vi.fn() }),
        execCommand: vi.fn(() => false),
        getSelection: () => ({ removeAllRanges: vi.fn(), addRange: vi.fn() }),
      },
    };
    const execute = vi.fn();

    expect(
      routeRendererHarnessCommandSelection(editor as unknown as HTMLElement, textCommand, execute),
    ).toBe(false);
    expect(editor.textContent).toBe("keep this draft");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["claude.compact", "text"],
    ["pi.compact", "text"],
    ["omp.compact", "text"],
    ["grok.compact", "text"],
    ["opencode.compact", "none"],
    ["dsh.compact", "none"],
  ] as const)("executes %s directly without changing the draft", (id, argumentMode) => {
    const editor = new FakeTextarea();
    const execute = vi.fn();
    const command = { ...noneCommand, id, argumentMode };

    expect(
      routeRendererHarnessCommandSelection(editor as unknown as HTMLElement, command, execute),
    ).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(editor.value).toBe("keep this draft");
    expect(editor.events).toHaveLength(0);
    expect(editor.focus).not.toHaveBeenCalled();

    execute.mockClear();
    expect(routeRendererHarnessCommandSelection(null, command, execute)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps argument-free commands on detached execution", () => {
    const execute = vi.fn();

    expect(routeRendererHarnessCommandSelection(null, noneCommand, execute)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});

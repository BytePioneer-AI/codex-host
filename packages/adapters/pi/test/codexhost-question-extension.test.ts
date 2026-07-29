import { describe, expect, it, vi } from "vitest";

import codexhostQuestionExtension from "../src/codexhost-question-extension.js";

interface CapturedDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute(
    toolCallId: string,
    params: { prompt: string; options?: string[]; multiline?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: {
      hasUI: boolean;
      ui: {
        select: ReturnType<typeof vi.fn>;
        input: ReturnType<typeof vi.fn>;
        editor: ReturnType<typeof vi.fn>;
      };
    },
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: { answered: boolean; answerType: "choice" | "text" };
  }>;
}

function captureDefinition(): CapturedDefinition {
  let captured: CapturedDefinition | null = null;
  codexhostQuestionExtension({
    registerTool(definition) {
      captured = definition as unknown as CapturedDefinition;
    },
  });
  if (!captured) throw new Error("Question Extension did not register its Tool");
  return captured;
}

describe("codexhost Pi Question Extension", () => {
  it("registers one side-effect-free model Question Tool", () => {
    const definition = captureDefinition();
    expect(definition).toMatchObject({
      name: "codexhost_question",
      label: "Ask user",
      parameters: expect.any(Object),
    });
    expect(Object.keys(definition).sort()).toEqual([
      "description",
      "execute",
      "label",
      "name",
      "parameters",
      "promptGuidelines",
      "promptSnippet",
    ]);
    expect(JSON.stringify(definition)).not.toMatch(
      /permission|project.?trust|filesystem|command/iu,
    );
    expect(JSON.stringify(definition.parameters)).not.toContain("timeoutMs");
  });

  it("uses select for choices and returns the answer to Pi", async () => {
    const definition = captureDefinition();
    const select = vi.fn(async () => "continue");
    const input = vi.fn();
    await expect(
      definition.execute(
        "tool-1",
        { prompt: "Continue?", options: ["continue", "stop"] },
        undefined,
        undefined,
        { hasUI: true, ui: { select, input, editor: vi.fn() } },
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "User answer: continue" }],
      details: { answered: true, answerType: "choice" },
    });
    expect(select).toHaveBeenCalledWith("Continue?", ["continue", "stop"], {});
    expect(input).not.toHaveBeenCalled();
  });

  it("uses input for free text and reports cancellation honestly", async () => {
    const definition = captureDefinition();
    const select = vi.fn();
    const input = vi.fn(async () => undefined);
    await expect(
      definition.execute("tool-2", { prompt: "Value?" }, undefined, undefined, {
        hasUI: true,
        ui: { select, input, editor: vi.fn() },
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "The user cancelled the question." }],
      details: { answered: false, answerType: "text" },
    });
    expect(input).toHaveBeenCalledWith("Value?", undefined, {});
    expect(select).not.toHaveBeenCalled();
  });

  it("uses the native editor for multiline text", async () => {
    const definition = captureDefinition();
    const editor = vi.fn(async () => "line one\nline two");
    await expect(
      definition.execute("tool-3", { prompt: "Draft?", multiline: true }, undefined, undefined, {
        hasUI: true,
        ui: { select: vi.fn(), input: vi.fn(), editor },
      }),
    ).resolves.toMatchObject({ details: { answered: true, answerType: "text" } });
    expect(editor).toHaveBeenCalledWith("Draft?");
  });

  it("rejects unsupported multiline combinations", async () => {
    const definition = captureDefinition();
    const context = {
      hasUI: true,
      ui: { select: vi.fn(), input: vi.fn(), editor: vi.fn() },
    };
    await expect(
      definition.execute(
        "tool-5",
        { prompt: "Invalid", options: ["yes", "no"], multiline: true },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("cannot have choices");
  });

  it("fails clearly when the native client has no UI", async () => {
    const definition = captureDefinition();
    await expect(
      definition.execute("tool-7", { prompt: "Value?" }, undefined, undefined, {
        hasUI: false,
        ui: { select: vi.fn(), input: vi.fn(), editor: vi.fn() },
      }),
    ).rejects.toThrow("requires an interactive client");
  });
});

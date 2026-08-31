import { describe, expect, it } from "vitest";

import { geminiInvocation } from "../src/command.js";

describe("Gemini ACP command", () => {
  it("starts the native Gemini CLI in ACP mode", () => {
    expect(geminiInvocation("gemini").arguments).toEqual(["--acp"]);
  });
});

import { describe, expect, it } from "vitest";

import {
  GrokPermissionConfirmation,
  grokPermissionLogFilter,
} from "../src/permission-confirmation.js";

const log = (message: string) => `2026-10-23T02:24:56.741602Z  INFO ${message}\n`;

describe("Grok native permission confirmation", () => {
  it("preserves the caller's logging filters and enables the native effective-state signal", () => {
    expect(grokPermissionLogFilter("warn,other=debug")).toBe(
      "warn,other=debug,xai_grok_workspace::permission::manager=info",
    );
  });

  it("requires both actual flags and handles split, colored native log lines", async () => {
    const confirmation = new GrokPermissionConfirmation("auto");
    let completed = false;
    void confirmation.completed.then(() => {
      completed = true;
    });
    confirmation.accept(log("Session received SetAutoMode: true"));
    confirmation.accept(log("auto permission mode set to: true").slice(0, 41));
    await Promise.resolve();
    expect(completed).toBe(false);
    confirmation.accept(log("auto permission mode set to: true").slice(41));
    await Promise.resolve();
    expect(completed).toBe(false);
    confirmation.accept(
      log(
        "\u001b[32mxai_grok_workspace::permission::manager: always-approve set to: false\u001b[0m",
      ),
    );
    await confirmation.completed;
    expect(completed).toBe(true);
  });

  it.each([
    ["always-approve", "always-approve set to: false"],
    ["auto", "auto permission mode set to: false"],
    ["ask", "always-approve set to: true"],
  ] as const)("rejects a native clamp of %s", async (mode, message) => {
    const confirmation = new GrokPermissionConfirmation(mode);
    const result = expect(confirmation.completed).rejects.toThrow("did not apply");
    confirmation.accept(log(message));
    await result;
  });

  it("ignores unstructured text, requested flags and incomplete records", async () => {
    const confirmation = new GrokPermissionConfirmation("ask");
    let completed = false;
    const result = confirmation.completed.then(() => {
      completed = true;
    });
    confirmation.accept("always-approve set to: false\nauto permission mode set to: false\n");
    confirmation.accept(log("SetYoloMode: false") + log("auto_mode=false"));
    confirmation.accept("x".repeat(20_000));
    confirmation.accept(log("always-approve set to: false"));
    confirmation.accept(log("auto permission mode set to: false").trimEnd());
    await Promise.resolve();
    expect(completed).toBe(false);
    confirmation.accept("\n");
    await result;
  });
});

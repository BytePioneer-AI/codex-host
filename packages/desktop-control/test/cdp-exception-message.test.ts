import { describe, expect, it } from "vitest";

import { cdpExceptionMessage } from "../src/cdp-client.js";

describe("CDP exception messages", () => {
  it("prefers the thrown value's description over the Uncaught summary", () => {
    expect(
      cdpExceptionMessage(
        {
          text: "Uncaught",
          exception: { description: "TypeError: x is undefined\n    at install (renderer.js:1:2)" },
        },
        "failed",
      ),
    ).toBe("TypeError: x is undefined\n    at install (renderer.js:1:2)");
  });

  it("falls back to the summary, then to the caller's message", () => {
    expect(cdpExceptionMessage({ text: "Uncaught" }, "failed")).toBe("Uncaught");
    expect(cdpExceptionMessage({}, "failed")).toBe("failed");
  });
});

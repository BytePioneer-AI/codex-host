import { describe, expect, it } from "vitest";

import { installReasoningTranscriptSoftWrap } from "../src/renderer-transcript-dom.js";

describe("Reasoning transcript soft wrap", () => {
  it("does not install styling when the owner document has no Window", () => {
    const dispose = installReasoningTranscriptSoftWrap({
      defaultView: null,
    } as unknown as Document);

    expect(dispose).not.toThrow();
    expect(() => dispose()).not.toThrow();
  });
});

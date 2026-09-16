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

  it("handles restricted environments where accessing localStorage throws", () => {
    const windowMock = {
      get localStorage(): Storage {
        throw new Error("Access is denied for this document");
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    } as unknown as Window;

    const styleMock = {
      setAttribute: () => {},
      remove: () => {},
      textContent: "",
      disabled: false,
    };
    const documentMock = {
      defaultView: windowMock,
      head: { append: () => {} },
      createElement: () => styleMock,
    } as unknown as Document;

    const dispose = installReasoningTranscriptSoftWrap(documentMock);
    expect(dispose).not.toThrow();
    expect(() => dispose()).not.toThrow();
  });
});

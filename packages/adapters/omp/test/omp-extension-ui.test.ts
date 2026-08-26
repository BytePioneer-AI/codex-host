import { describe, expect, it } from "vitest";

import { dispatchOmpExtensionUi, parseOmpExtensionUiRequest } from "../src/omp-extension-ui.js";

describe("OMP Extension UI bridge", () => {
  it("parses non-blocking UI requests without confusing them with Questions", () => {
    expect(
      parseOmpExtensionUiRequest({
        type: "extension_ui_request",
        id: "notify-1",
        method: "notify",
        message: "done",
        notifyType: "info",
      }),
    ).toEqual({
      id: "notify-1",
      method: "notify",
      message: "done",
      notifyType: "info",
    });
    expect(
      parseOmpExtensionUiRequest({
        type: "extension_ui_request",
        id: "widget-1",
        method: "setWidget",
        widgetKey: "status",
        widgetLines: ["ready"],
        widgetPlacement: "belowEditor",
      }),
    ).toMatchObject({ method: "setWidget", widgetLines: ["ready"] });
    expect(
      parseOmpExtensionUiRequest({
        type: "extension_ui_request",
        id: "question-1",
        method: "select",
        title: "Choose",
        options: ["a"],
      }),
    ).toBeNull();
  });

  it("dispatches supported non-blocking UI requests to optional handlers", async () => {
    const calls: string[] = [];
    const request = parseOmpExtensionUiRequest({
      type: "extension_ui_request",
      id: "url-1",
      method: "open_url",
      url: "https://example.test",
      launchUrl: "http://127.0.0.1:1234",
      instructions: "Open this URL",
    });
    if (!request) throw new Error("Expected a parsed URL request");
    await dispatchOmpExtensionUi(request, {
      openUrl: (value) => {
        calls.push(`${value.url}:${value.launchUrl ?? ""}`);
      },
    });
    expect(calls).toEqual(["https://example.test:http://127.0.0.1:1234"]);
  });
});

import { describe, expect, it } from "vitest";

import { inspectRendererDom, validateRendererDomInspection } from "../src/index.js";

const sanitizedInspection = {
  totalNodes: 5,
  nodeNameCounts: {
    html: 1,
    body: 1,
    div: 1,
    textarea: 1,
    button: 1,
  },
  shadowRoots: [
    {
      shadowRootType: "open",
      childNodeCount: 2,
    },
  ],
  editorCandidates: [
    {
      nodeName: "textarea",
      attributeNames: ["aria-label", "data-placeholder"],
      reasons: ["textarea", "data-placeholder"],
      ancestorNames: ["html", "body", "div"],
    },
  ],
  sendButtonCandidates: [
    {
      nodeName: "button",
      attributeNames: ["aria-label", "type"],
      reasons: ["type=submit"],
      ancestorNames: ["html", "body", "div"],
    },
  ],
};

describe("Renderer DOM inspection", () => {
  it("validates and returns only structural candidate data", () => {
    const result = validateRendererDomInspection({
      ...sanitizedInspection,
      privatePrompt: "private prompt text",
    });

    expect(result).toEqual(sanitizedInspection);
    expect(JSON.stringify(result)).not.toContain("private prompt text");
  });

  it("evaluates a structural summary without reading visible text or input values", async () => {
    let expression = "";
    const client = {
      async evaluate<T>(candidate: string): Promise<T> {
        expression = candidate;
        return sanitizedInspection as T;
      },
    };

    await expect(inspectRendererDom(client)).resolves.toEqual(sanitizedInspection);
    expect(expression).not.toMatch(/textContent|innerText|innerHTML|outerHTML|\.value/u);
    expect(expression).toContain("getAttributeNames");
  });
});

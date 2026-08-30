import { describe, expect, it } from "vitest";

import { validateRendererContractAuditInspection } from "../src/index.js";

const validInspection = {
  schemaVersion: 1,
  composer: {
    composerCount: 1,
    visibleComposerCount: 1,
    activeComposerCount: 1,
    modelCandidateCount: 1,
    verifiedModelCandidateCount: 1,
    permissionCandidateCount: 0,
    verifiedPermissionCandidateCount: 0,
    contextUsageCandidateCount: 0,
    verifiedContextUsageCandidateCount: 0,
    sendButtonCount: 1,
    trailingActionOwnerCount: 1,
  },
  model: { draftCount: 1, conversationCount: 0, missingCount: 0, ambiguousCount: 0 },
  settings: { headerCount: 1, visibleHeaderCount: 1, insertionPointCount: 1 },
  sidebar: { rowCount: 0, titleOwnerCount: 0, resolvedThreadCount: 0, ambiguousThreadCount: 0 },
  transcript: {
    turnCount: 4,
    itemNodeCount: 5,
    identifiedItemCount: 11,
    textBodyCount: 2,
    textBodyOwnerCount: 2,
  },
  fork: { annotatedResponseCount: 0, candidateButtonCount: 0, verifiedButtonCount: 0 },
  production: {
    bindingPresent: false,
    adapterState: "absent",
    adapterReason: "absent",
    titlePolicyState: "absent",
    draftPrewarmPolicyState: "absent",
  },
};

describe("Desktop contract audit inspection", () => {
  it("accepts the bounded Renderer schema", () => {
    expect(validateRendererContractAuditInspection(validInspection)).toEqual(validInspection);
  });

  it("rejects unknown fields and private values", () => {
    expect(() =>
      validateRendererContractAuditInspection({ ...validInspection, prompt: "private" }),
    ).toThrow("unknown or missing fields");
    expect(() =>
      validateRendererContractAuditInspection({
        ...validInspection,
        production: { ...validInspection.production, source: "function source" },
      }),
    ).toThrow("unknown or missing fields");
  });
});

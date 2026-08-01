import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { DraftAgentController } from "../src/index.js";

function controller(): DraftAgentController<object> {
  return new DraftAgentController<object>({
    idFactory: (sequence) => `composer-${sequence}`,
  });
}

describe("Renderer draft Agent controller", () => {
  it("isolates Agent selection by Composer", async () => {
    const firstComposer = {};
    const secondComposer = {};
    const agents = controller();

    await agents.switchAgent(firstComposer, "pi", {
      applyAgent: () => true,
      clearPrewarm: async () => undefined,
    });

    expect(agents.get(firstComposer)).toEqual({
      composerId: "composer-1",
      agent: "pi",
      phase: "draft",
    });
    expect(agents.get(secondComposer)).toEqual({
      composerId: "composer-2",
      agent: "codex",
      phase: "draft",
    });
  });

  it("uses only the most recently submitted Agent for new default Composers", async () => {
    const submittedPi = {};
    const unsubmittedDraft = {};
    const openedCodex = {};
    const afterPassiveWork = {};
    const afterCodexSubmission = {};
    const agents = controller();
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.submitted" });
    const operations = {
      applyAgent: () => true,
      clearPrewarm: async () => undefined,
    };

    agents.mount(submittedPi, ["default"]);
    await agents.switchAgent(submittedPi, "pi", operations);
    agents.setPiModel(submittedPi, model);
    agents.lock(submittedPi);
    agents.recordSubmission(submittedPi);

    agents.mount(unsubmittedDraft, ["default"]);
    expect(agents.get(unsubmittedDraft)).toEqual({
      composerId: "composer-2",
      agent: "pi",
      phase: "draft",
    });
    await agents.switchAgent(unsubmittedDraft, "codex", operations);

    agents.mount(openedCodex, ["conversation", "official-thread"]);
    expect(agents.get(openedCodex)).toMatchObject({ agent: "codex", phase: "draft" });
    agents.restore(openedCodex, "codex");

    agents.mount(afterPassiveWork, ["default"]);
    expect(agents.get(afterPassiveWork)).toEqual({
      composerId: "composer-4",
      agent: "pi",
      phase: "draft",
    });
    expect(agents.get(afterPassiveWork).piModel).toBeUndefined();

    agents.recordSubmission(openedCodex);
    agents.mount(afterCodexSubmission, ["default"]);
    expect(agents.get(afterCodexSubmission)).toMatchObject({
      agent: "codex",
      phase: "draft",
    });
  });

  it("uses an enabled production launch default before any submission", () => {
    const composer = {};
    const agents = new DraftAgentController<object>({
      idFactory: (sequence) => `composer-${sequence}`,
      defaultAgent: "pi",
    });

    agents.mount(composer, ["default"]);
    expect(agents.get(composer)).toEqual({
      composerId: "composer-1",
      agent: "pi",
      phase: "draft",
    });
    expect(
      () =>
        new DraftAgentController<object>({
          enabledAgents: ["codex", "pi"],
          defaultAgent: "claude-code",
        }),
    ).toThrow("default Agent must be enabled");
  });

  it("enables Claude Code in the default production Agent list", async () => {
    const composer = {};
    const agents = controller();
    const applyAgent = vi.fn(() => true);

    await expect(
      agents.switchAgent(composer, "claude-code", {
        applyAgent,
        clearPrewarm: vi.fn(async () => undefined),
      }),
    ).resolves.toBe(true);
    expect(applyAgent).toHaveBeenCalledWith("claude-code");
    expect(agents.get(composer).agent).toBe("claude-code");
  });

  it("uses the same draft lifecycle for explicitly enabled Claude Code", async () => {
    const composer = {};
    const agents = new DraftAgentController<object>({
      idFactory: (sequence) => `composer-${sequence}`,
      enabledAgents: ["codex", "pi", "claude-code"],
    });
    const operations = {
      applyAgent: vi.fn(() => true),
      clearPrewarm: vi.fn(async () => undefined),
    };

    await expect(agents.switchAgent(composer, "pi", operations)).resolves.toBe(true);
    await expect(agents.switchAgent(composer, "claude-code", operations)).resolves.toBe(true);
    await expect(agents.switchAgent(composer, "codex", operations)).resolves.toBe(true);

    expect(operations.applyAgent).toHaveBeenNthCalledWith(1, "pi");
    expect(operations.applyAgent).toHaveBeenNthCalledWith(2, "claude-code");
    expect(operations.applyAgent).toHaveBeenNthCalledWith(3, "codex");
    expect(agents.get(composer)).toMatchObject({ agent: "codex", phase: "draft" });
  });

  it("keeps the draft mutable until submission locks the final Agent", async () => {
    const composer = {};
    const agents = controller();
    const operations = {
      applyAgent: () => true,
      clearPrewarm: async () => undefined,
    };

    await agents.switchAgent(composer, "pi", operations);
    await agents.switchAgent(composer, "codex", operations);
    await agents.switchAgent(composer, "pi", operations);
    expect(agents.get(composer)).toMatchObject({ agent: "pi", phase: "draft" });

    agents.lock(composer);
    await expect(agents.switchAgent(composer, "codex", operations)).resolves.toBe(false);
    expect(agents.get(composer)).toEqual({
      composerId: "composer-1",
      agent: "pi",
      phase: "locked",
    });
  });

  it("transfers identity, selection, and switching state to one replacement Composer", async () => {
    const originalComposer = {};
    const replacementComposer = {};
    const existingComposer = {};
    const agents = controller();
    let releaseClear: (() => void) | undefined;
    const switching = agents.switchAgent(originalComposer, "pi", {
      applyAgent: () => true,
      clearPrewarm: () =>
        new Promise<void>((resolve) => {
          releaseClear = resolve;
        }),
    });
    agents.get(existingComposer);

    expect(agents.transfer(originalComposer, replacementComposer)).toBe(true);
    expect(agents.isSwitching(replacementComposer)).toBe(true);
    expect(agents.transfer(originalComposer, existingComposer)).toBe(false);
    releaseClear?.();
    await switching;

    expect(agents.get(replacementComposer)).toEqual({
      composerId: "composer-1",
      agent: "pi",
      phase: "draft",
    });
    expect(agents.get(existingComposer)).toEqual({
      composerId: "composer-2",
      agent: "codex",
      phase: "draft",
    });
  });

  it("restores a submitted Agent when its conversation target is revisited", async () => {
    const draftComposer = {};
    const firstConversation = {};
    const secondConversation = {};
    const revisitedConversation = {};
    const firstTargetMember = {};
    const secondTargetMember = {};
    const draftTarget = ["default"];
    const firstTarget = ["conversation", firstTargetMember];
    const equivalentFirstTarget = ["conversation", firstTargetMember];
    const secondTarget = ["conversation", secondTargetMember];
    const agents = controller();

    agents.mount(draftComposer, draftTarget);
    await agents.switchAgent(draftComposer, "pi", {
      applyAgent: () => true,
      clearPrewarm: async () => undefined,
    });
    agents.lock(draftComposer);
    expect(agents.transfer(draftComposer, firstConversation, firstTarget)).toBe(true);

    agents.mount(secondConversation, secondTarget);
    expect(agents.get(secondConversation)).toMatchObject({ agent: "codex", phase: "draft" });
    agents.mount(revisitedConversation, equivalentFirstTarget);

    expect(agents.get(revisitedConversation)).toEqual({
      composerId: "composer-1",
      agent: "pi",
      phase: "locked",
    });
  });

  it("binds an in-place first conversation target to the existing logical Composer", async () => {
    const composer = {};
    const revisit = {};
    const defaultTarget = ["default"];
    const conversationTarget = ["conversation", "late-fork-thread"];
    const agents = controller();

    agents.mount(composer, defaultTarget);
    await agents.switchAgent(composer, "pi", {
      applyAgent: () => true,
      clearPrewarm: async () => undefined,
    });
    agents.lock(composer);
    const original = agents.get(composer);

    expect(agents.transfer(composer, composer, conversationTarget)).toBe(true);
    agents.mount(revisit, ["conversation", "late-fork-thread"]);

    expect(agents.get(revisit)).toEqual(original);
  });

  it("restores a newly mounted Fork owner and ignores stale ownership generations", () => {
    const forkComposer = {};
    const replacement = {};
    const target = ["conversation", "fork-thread"];
    const agents = controller();
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.fork" });

    agents.mount(forkComposer, target);
    const stale = agents.beginOwnershipRequest(forkComposer);
    const current = agents.beginOwnershipRequest(forkComposer);
    expect(agents.isCurrentOwnershipRequest(forkComposer, stale)).toBe(false);
    expect(agents.isCurrentOwnershipRequest(forkComposer, current)).toBe(true);
    expect(agents.restore(forkComposer, "pi", model)).toMatchObject({
      agent: "pi",
      phase: "locked",
      piModel: model,
    });

    agents.mount(replacement, ["conversation", "fork-thread"]);
    expect(agents.get(replacement)).toMatchObject({
      agent: "pi",
      phase: "locked",
      piModel: model,
    });
    expect(agents.restore(replacement, "claude-code")).toMatchObject({
      agent: "claude-code",
      phase: "locked",
    });
  });

  it("transfers Pi Model state and request generations with logical Composer identity", () => {
    const draft = {};
    const conversation = {};
    const revisit = {};
    const newDefault = {};
    const targetMember = {};
    const target = ["conversation", targetMember];
    const agents = controller();
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.synthetic" });

    agents.mount(draft, ["default"]);
    agents.setPiModel(draft, model);
    const firstGeneration = agents.beginModelRequest(draft);
    expect(agents.transfer(draft, conversation, target)).toBe(true);
    expect(agents.get(conversation).piModel).toEqual(model);
    expect(agents.isCurrentModelRequest(conversation, firstGeneration)).toBe(true);

    const secondGeneration = agents.beginModelRequest(conversation);
    expect(agents.isCurrentModelRequest(draft, firstGeneration)).toBe(false);
    expect(agents.isCurrentModelRequest(draft, secondGeneration)).toBe(true);
    agents.mount(revisit, ["conversation", targetMember]);
    expect(agents.get(revisit).piModel).toEqual(model);

    agents.mount(newDefault, ["default"]);
    expect(agents.get(newDefault).piModel).toBeUndefined();
  });

  it("applies the target Agent before clearing stale prewarm", async () => {
    const composer = {};
    const agents = controller();
    const operations: string[] = [];

    await expect(
      agents.switchAgent(composer, "pi", {
        applyAgent(agent) {
          operations.push(`apply:${agent}`);
          return true;
        },
        async clearPrewarm() {
          operations.push("clear");
        },
      }),
    ).resolves.toBe(true);

    expect(operations).toEqual(["apply:pi", "clear"]);
    expect(agents.get(composer).agent).toBe("pi");
  });

  it("rejects concurrent switching for the same logical Composer", async () => {
    const composer = {};
    const agents = controller();
    let releaseClear: (() => void) | undefined;
    const first = agents.switchAgent(composer, "pi", {
      applyAgent: () => true,
      clearPrewarm: () =>
        new Promise<void>((resolve) => {
          releaseClear = resolve;
        }),
    });

    expect(agents.isSwitching(composer)).toBe(true);
    await expect(
      agents.switchAgent(composer, "pi", {
        applyAgent: vi.fn(() => true),
        clearPrewarm: vi.fn(async () => undefined),
      }),
    ).resolves.toBe(false);
    releaseClear?.();
    await first;
    expect(agents.isSwitching(composer)).toBe(false);
  });

  it("restores the prior Agent when prewarm clearing fails", async () => {
    const composer = {};
    const agents = controller();
    const operations: string[] = [];

    await expect(
      agents.switchAgent(composer, "pi", {
        applyAgent(agent) {
          operations.push(`apply:${agent}`);
          return true;
        },
        async clearPrewarm() {
          operations.push("clear");
          throw new Error("synthetic clear failure");
        },
      }),
    ).resolves.toBe(false);

    expect(operations).toEqual(["apply:pi", "clear", "apply:codex"]);
    expect(agents.get(composer).agent).toBe("codex");
  });

  it("fails closed when the prior Agent cannot be restored", async () => {
    const composer = {};
    const agents = controller();

    await expect(
      agents.switchAgent(composer, "pi", {
        applyAgent(agent) {
          return agent === "pi";
        },
        async clearPrewarm() {
          throw new Error("synthetic clear failure");
        },
      }),
    ).rejects.toThrow("could not restore the prior Agent");
    expect(agents.isSwitching(composer)).toBe(false);
  });
});

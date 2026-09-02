import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { DraftAgentController } from "../src/index.js";
import { scopedComposerTarget } from "../src/renderer-binding-probe.js";

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

  it("keeps OpenCode Model and Thinking selection scoped to its draft", async () => {
    const composer = {};
    const agents = controller();
    const model = harnessModelRefSchema.parse({
      id: "opencode-model-v1.WyJwcm92aWRlci0xIiwibW9kZWwtMSJd",
    });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("ocv.aGlnaA");

    await agents.switchAgent(composer, "opencode", {
      applyAgent: () => true,
      clearPrewarm: async () => undefined,
    });
    agents.setExternalModel(composer, "opencode", model);
    agents.setExternalThinkingOption(composer, "opencode", thinkingOptionId);

    expect(agents.get(composer)).toMatchObject({
      agent: "opencode",
      openCodeModel: model,
      openCodeThinkingOptionId: thinkingOptionId,
    });
    expect(agents.modelForAgent(composer, "opencode")).toEqual(model);
    expect(agents.thinkingOptionForAgent(composer, "opencode")).toBe(thinkingOptionId);
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

  it("keeps a locally rejected submission mutable and locks only after a Thread binds", async () => {
    const rejectedComposer = {};
    const acceptedComposer = {};
    const agents = controller();
    const operations = {
      applyAgent: () => true,
      clearPrewarm: async () => undefined,
    };

    await agents.switchAgent(rejectedComposer, "grok", operations);
    agents.markSubmissionPending(rejectedComposer);
    expect(agents.isSubmissionPending(rejectedComposer)).toBe(true);
    expect(agents.get(rejectedComposer).phase).toBe("draft");

    agents.clearPendingSubmission(rejectedComposer);
    expect(agents.isSubmissionPending(rejectedComposer)).toBe(false);
    await expect(agents.switchAgent(rejectedComposer, "codex", operations)).resolves.toBe(true);

    await agents.switchAgent(acceptedComposer, "grok", operations);
    agents.markSubmissionPending(acceptedComposer);
    expect(
      agents.transfer(acceptedComposer, acceptedComposer, ["conversation", "grok-thread"]),
    ).toBe(true);
    expect(agents.isSubmissionPending(acceptedComposer)).toBe(false);
    expect(agents.get(acceptedComposer)).toMatchObject({ agent: "grok", phase: "locked" });
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

  it("does not reuse a Thread Agent state across Hosts", () => {
    const composer = {};
    const target = ["conversation", "same-thread"] as const;
    const agents = controller();
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.remote" });
    const localTarget = scopedComposerTarget(target, "local");
    const remoteTarget = scopedComposerTarget(target, "remote-ssh:company");

    agents.mount(composer, localTarget);
    agents.restore(composer, "pi", model);
    expect(agents.get(composer)).toMatchObject({ agent: "pi", piModel: model });

    expect(agents.rebindConversation(composer, remoteTarget)).toMatchObject({
      agent: "codex",
      phase: "draft",
    });
    expect(agents.get(composer)).not.toHaveProperty("piModel");

    expect(agents.rebindConversation(composer, localTarget)).toMatchObject({
      agent: "pi",
      phase: "locked",
      piModel: model,
    });
  });

  it("rebinds a reused Composer without carrying another conversation's Pi state", () => {
    const composer = {};
    const piTarget = ["conversation", "pi-thread"];
    const codexTarget = ["conversation", "codex-thread"];
    const agents = controller();
    const model = harnessModelRefSchema.parse({ id: "openai~gpt-5.6-sol" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");

    agents.mount(composer, piTarget);
    agents.restore(composer, "pi", model, thinkingOptionId);
    const staleModelRequest = agents.beginModelRequest(composer);
    const staleOwnershipRequest = agents.beginOwnershipRequest(composer);

    expect(agents.rebindConversation(composer, codexTarget)).toMatchObject({
      agent: "codex",
      phase: "draft",
    });
    expect(agents.get(composer)).not.toHaveProperty("piModel");
    expect(agents.get(composer)).not.toHaveProperty("piThinkingOptionId");
    expect(agents.isCurrentModelRequest(composer, staleModelRequest)).toBe(false);
    expect(agents.isCurrentOwnershipRequest(composer, staleOwnershipRequest)).toBe(false);

    expect(agents.restore(composer, "codex")).toMatchObject({
      agent: "codex",
      phase: "locked",
    });
  });

  it("restores a newly mounted Fork owner and ignores stale ownership generations", () => {
    const forkComposer = {};
    const replacement = {};
    const target = ["conversation", "fork-thread"];
    const agents = controller();
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.fork" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
    const staleClaudePermissionMode = harnessPermissionModeIdSchema.parse("acceptEdits");

    agents.mount(forkComposer, target);
    agents.setExternalPermissionMode(forkComposer, "claude-code", staleClaudePermissionMode);
    const stale = agents.beginOwnershipRequest(forkComposer);
    const current = agents.beginOwnershipRequest(forkComposer);
    expect(agents.isCurrentOwnershipRequest(forkComposer, stale)).toBe(false);
    expect(agents.isCurrentOwnershipRequest(forkComposer, current)).toBe(true);
    expect(agents.restore(forkComposer, "pi", model, thinkingOptionId)).toMatchObject({
      agent: "pi",
      phase: "locked",
      piModel: model,
      piThinkingOptionId: thinkingOptionId,
    });

    agents.mount(replacement, ["conversation", "fork-thread"]);
    expect(agents.get(replacement)).toMatchObject({
      agent: "pi",
      phase: "locked",
      piModel: model,
      piThinkingOptionId: thinkingOptionId,
    });
    expect(agents.restore(replacement, "claude-code")).toMatchObject({
      agent: "claude-code",
      phase: "locked",
    });
    expect(agents.permissionModeForAgent(replacement, "claude-code")).toBeUndefined();
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
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("xhigh");

    agents.mount(draft, ["default"]);
    agents.setPiConfiguration(draft, model, thinkingOptionId);
    const firstGeneration = agents.beginModelRequest(draft);
    expect(agents.transfer(draft, conversation, target)).toBe(true);
    expect(agents.get(conversation)).toMatchObject({
      piModel: model,
      piThinkingOptionId: thinkingOptionId,
    });
    expect(agents.isCurrentModelRequest(conversation, firstGeneration)).toBe(true);

    const secondGeneration = agents.beginModelRequest(conversation);
    expect(agents.isCurrentModelRequest(draft, firstGeneration)).toBe(false);
    expect(agents.isCurrentModelRequest(draft, secondGeneration)).toBe(true);
    agents.mount(revisit, ["conversation", targetMember]);
    expect(agents.get(revisit)).toMatchObject({
      piModel: model,
      piThinkingOptionId: thinkingOptionId,
    });

    agents.mount(newDefault, ["default"]);
    expect(agents.get(newDefault).piModel).toBeUndefined();
    expect(agents.get(newDefault).piThinkingOptionId).toBeUndefined();
  });

  it("isolates Claude and Pi Model state across one logical Composer lifecycle", async () => {
    const draft = {};
    const conversation = {};
    const revisit = {};
    const newDefault = {};
    const agents = controller();
    const piModel = harnessModelRefSchema.parse({ id: "pi-model-v1.isolated" });
    const claudeModel = harnessModelRefSchema.parse({ id: "claude-model-v1.isolated" });
    const claudePermissionMode = harnessPermissionModeIdSchema.parse("acceptEdits");
    const piPermissionMode = harnessPermissionModeIdSchema.parse("future-pi-mode");
    const piThinking = harnessThinkingOptionIdSchema.parse("max");
    const claudeThinking = harnessThinkingOptionIdSchema.parse("auto");

    agents.mount(draft, ["default"]);
    agents.setExternalModel(draft, "pi", piModel);
    agents.setExternalModel(draft, "claude-code", claudeModel);
    agents.setExternalPermissionMode(draft, "pi", piPermissionMode);
    agents.setExternalPermissionMode(draft, "claude-code", claudePermissionMode);
    agents.setExternalThinkingOption(draft, "pi", piThinking);
    agents.setExternalThinkingOption(draft, "claude-code", claudeThinking);
    expect(agents.modelForAgent(draft, "pi")).toEqual(piModel);
    expect(agents.modelForAgent(draft, "claude-code")).toEqual(claudeModel);
    expect(agents.permissionModeForAgent(draft, "pi")).toBe(piPermissionMode);
    expect(agents.permissionModeForAgent(draft, "claude-code")).toBe(claudePermissionMode);
    expect(agents.thinkingOptionForAgent(draft, "pi")).toBe(piThinking);
    expect(agents.thinkingOptionForAgent(draft, "claude-code")).toBe(claudeThinking);
    expect(agents.transfer(draft, conversation, ["conversation", "claude-thread"])).toBe(true);
    agents.mount(revisit, ["conversation", "claude-thread"]);
    expect(agents.get(revisit)).toMatchObject({
      piModel,
      piThinkingOptionId: piThinking,
      claudeModel,
      claudeThinkingOptionId: claudeThinking,
      permissionModeByAgent: {
        pi: piPermissionMode,
        "claude-code": claudePermissionMode,
      },
    });

    agents.mount(newDefault, ["default"]);
    expect(agents.modelForAgent(newDefault, "pi")).toBeUndefined();
    expect(agents.modelForAgent(newDefault, "claude-code")).toBeUndefined();
    expect(agents.permissionModeForAgent(newDefault, "pi")).toBeUndefined();
    expect(agents.permissionModeForAgent(newDefault, "claude-code")).toBeUndefined();
    expect(agents.thinkingOptionForAgent(newDefault, "pi")).toBeUndefined();
    expect(agents.thinkingOptionForAgent(newDefault, "claude-code")).toBeUndefined();
  });

  it("keeps an Antigravity effort selection so the carrier can encode it", () => {
    const draft = {};
    const agents = controller();
    const effort = harnessThinkingOptionIdSchema.parse("low");
    const model = harnessModelRefSchema.parse({ id: "gemini-3.1-pro" });
    agents.mount(draft, ["default"]);
    agents.setExternalModel(draft, "antigravity", model);
    agents.setExternalThinkingOption(draft, "antigravity", effort);

    // Without this the composer builds a carrier with no effort and the first
    // Turn runs without --effort.
    expect(agents.thinkingOptionForAgent(draft, "antigravity")).toBe(effort);
    expect(agents.get(draft)).toMatchObject({
      antigravityModel: model,
      antigravityThinkingOptionId: effort,
    });

    agents.setExternalThinkingOption(draft, "antigravity", undefined);
    expect(agents.thinkingOptionForAgent(draft, "antigravity")).toBeUndefined();
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

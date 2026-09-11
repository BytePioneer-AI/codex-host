import { describe, expect, it } from "vitest";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { DraftAgentController, KNOWN_RENDERER_AGENTS } from "../src/agent-selection-state.js";

describe("restored native model ownership", () => {
  it.each(KNOWN_RENDERER_AGENTS.filter((agent) => agent !== "codex"))(
    "clears a stale %s model when the restored Thread has no model",
    (agent) => {
      const controller = new DraftAgentController<object>(),
        composer = {};
      controller.mount(composer, ["default"]);
      const model = harnessModelRefSchema.parse({ id: "old-native-model" });
      controller.restore(composer, agent, model);
      expect(controller.modelForAgent(composer, agent)).toEqual(model);
      controller.restore(composer, agent);
      expect(controller.modelForAgent(composer, agent)).toBeUndefined();
    },
  );
});

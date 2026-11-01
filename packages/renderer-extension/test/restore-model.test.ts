import { describe, expect, it } from "vitest";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { DraftAgentController } from "../src/agent-selection-state.js";
import { testPluginIds } from "../../../tests/fixtures/harness-plugin-descriptors.js";

describe("restored native model ownership", () => {
  it.each([...testPluginIds, "previously-unknown"])(
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

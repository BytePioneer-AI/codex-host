import { describe, expect, it } from "vitest";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { DraftAgentController } from "../src/agent-selection-state.js";
import { testPluginIds } from "../../../tests/fixtures/harness-plugin-descriptors.js";

describe("restored native model ownership", () => {
  // The standalone Codex Adapter does not change Desktop's reserved native route.
  it.each([...testPluginIds.filter((id) => id !== "codex"), "previously-unknown"])(
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

  it("leaves official Codex model ownership with Desktop", () => {
    const controller = new DraftAgentController<object>();
    const composer = {};
    controller.mount(composer, ["default"]);
    const model = harnessModelRefSchema.parse({ id: "native-codex-model" });
    controller.restore(composer, "codex", model);
    expect(controller.get(composer)).toMatchObject({ agent: "codex", phase: "locked" });
    expect(controller.modelForAgent(composer, "codex")).toBeUndefined();
    expect(controller.get(composer).configurationByAgent).toBeUndefined();
    controller.restore(composer, "codex");
    expect(controller.modelForAgent(composer, "codex")).toBeUndefined();
  });
});

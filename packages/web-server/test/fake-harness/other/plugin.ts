/** A second scripted identity for Harness/model separation browser acceptance. */
import { createHarnessAdapter as createFake } from "../fake/plugin.ts";

export function createHarnessAdapter() {
  const adapter = createFake({
    harnessId: "other",
    modelId: "other-model",
    modelLabel: "Other Model",
    thinkingOptions: [
      { id: "off", label: "Off" },
      { id: "auto", label: "Auto" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "extra-high", label: "Extra High" },
      { id: "max", label: "Max" },
      { id: "ultracode", label: "Ultracode" },
    ],
    defaultThinkingOptionId: "high",
    permissionModeScope: "atCreate",
    permissionModes: {
      modes: [
        { id: "auto", label: "Native Auto", description: "Native classifier, not a DSH review." },
        {
          id: "other-full",
          label: "Other Full",
          description: "Native unrestricted execution.",
          dangerous: true,
        },
      ],
      defaultModeId: "auto",
    },
  });
  const inspect = adapter.inspect;
  adapter.inspect = async () => {
    const inspection = await inspect();
    inspection.catalog.models.push(
      { ref: { id: "other-alternate" }, label: "Other Alternate" },
      { ref: { id: "other-compact" }, label: "Other Compact" },
      { ref: { id: "other-fast" }, label: "Other Fast" },
      { ref: { id: "other-large" }, label: "Other Large" },
      { ref: { id: "other-preview" }, label: "Other Preview" },
    );
    return inspection;
  };
  return adapter;
}

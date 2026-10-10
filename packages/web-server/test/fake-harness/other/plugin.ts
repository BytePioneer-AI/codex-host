/** A second scripted identity for Harness/model separation browser acceptance. */
import { createHarnessAdapter as createFake } from "../fake/plugin.ts";

export function createHarnessAdapter() {
  const adapter = createFake({
    harnessId: "other",
    modelId: "other-model",
    modelLabel: "Other Model",
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
    inspection.catalog.models.push({ ref: { id: "other-alternate" }, label: "Other Alternate" });
    return inspection;
  };
  return adapter;
}

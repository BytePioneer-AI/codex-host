import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Native process-registry format observed in the bundled ZCode runtime. Test-only credentials. */
export async function writePersonalProviderFixture(root: string, baseURL: string): Promise<void> {
  const directory = path.join(root, ".zcode", "v2");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "provider_config.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "fixture",
              providerName: "Fixture",
              enabled: true,
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "test-only" },
                api: { type: "anthropic-messages", baseUrl: baseURL },
                personalModelIds: ["fixture-model", "fixture-reasoning"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: "fixture",
              modelId: "fixture-model",
              config: { optionSpecs: { reasoningLevel: { values: ["disabled"], map: "{}" } } },
            },
            {
              providerId: "fixture",
              modelId: "fixture-reasoning",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high"], map: "{}" } } },
            },
          ],
          manualProviderModelRules: [],
        },
        defaultModelSelection: { providerId: "fixture", modelId: "fixture-model" },
      },
    }),
  );
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { HarnessModelCatalog } from "@codexhost/shared-contracts";
import { decodePiModelRef, encodePiModelRef, type PiNativeModel } from "./pi-model-catalog.js";

export const PI_FAST_COMMAND = "codexhost-fast-mode";
export const PI_FAST_ACK = "codexhost-fast-mode:";

/** Loaded explicitly by Host, never installed in Pi's global settings. Off is inert. */
export const PI_FAST_EXTENSION = `export default function(pi) {
  let target;
  const wrapped = new Set();
  const supportsModel = (model) => model && (model.api === "openai-codex-responses" || model.api === "openai-responses") && /gpt/i.test(model.id);
  pi.on("model_select", (_event, ctx) => {
    if (target && (target.provider !== ctx.model?.provider || target.id !== ctx.model?.id || !supportsModel(ctx.model))) target = undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    if (typeof ctx.modelRegistry.getProvider !== "function" || typeof pi.registerProvider !== "function") return;
    pi.registerCommand("${PI_FAST_COMMAND}", {
      description: "Codex Host Fast mode",
      handler: async (args, ctx) => {
        const [mode, nonce] = args.split(" ");
        if (!nonce || (mode !== "on" && mode !== "off")) throw new Error("Invalid Fast selection");
        if (mode === "on") {
          const model = ctx.model;
          if (!supportsModel(model)) throw new Error("Fast requires a GPT model using the Codex or OpenAI Responses API");
          const original = ctx.modelRegistry.getProvider(model.provider);
          if (!original) throw new Error("Provider is unavailable");
          if (!wrapped.has(model.provider)) {
            const options = (model, value) => target && supportsModel(model) && target.provider === model.provider && target.id === model.id
              ? {
                  ...value,
                  serviceTier: "priority",
                  // Pi streamSimple drops serviceTier but preserves onPayload.
                  onPayload: async (payload, requestModel) => {
                    const request = { ...payload, service_tier: "priority" };
                    const replacement = await value?.onPayload?.(request, requestModel);
                    return { ...(replacement === undefined ? request : replacement), service_tier: "priority" };
                  },
                } : value;
            pi.registerProvider({
              ...original,
              stream: (model, context, value) => original.stream(model, context, options(model, value)),
              streamSimple: (model, context, value) => original.streamSimple(model, context, options(model, value)),
            });
            wrapped.add(model.provider);
          }
          target = { provider: model.provider, id: model.id };
        } else target = undefined;
        ctx.ui.notify("${PI_FAST_ACK}" + nonce + ":" + mode, "info");
      },
    });
  });
}
`;

/** Content-addressed Host resource: concurrent starts and installed plugin versions cannot race. */
export async function ensurePiFastExtension(environment: NodeJS.ProcessEnv): Promise<string> {
  const digest = createHash("sha256").update(PI_FAST_EXTENSION).digest("hex").slice(0, 16);
  const dataDirectory =
    environment.CODEXHOST_DATA_DIR ??
    path.join(environment.HOME ?? environment.USERPROFILE ?? homedir(), ".codexhost");
  const directory = path.resolve(dataDirectory, "extensions", "pi-codex-fast");
  const file = path.join(directory, `${digest}.mjs`);
  if ((await readFile(file, "utf8").catch(() => "")) === PI_FAST_EXTENSION) return file;
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, PI_FAST_EXTENSION, { mode: 0o600 });
    try {
      await rename(temporary, file);
    } catch (error) {
      // Windows may refuse to replace the file another start just published.
      // Accept only the exact resource; do not hide an unsuccessful write.
      if ((await readFile(file, "utf8").catch(() => "")) !== PI_FAST_EXTENSION) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}

/** Eligible request targets; upstream acceptance of priority is not guaranteed. */
export function piFastModelKeys(models: readonly PiNativeModel[]): Set<string> {
  return new Set(
    models
      .filter(
        (model) =>
          (model.api === "openai-codex-responses" || model.api === "openai-responses") &&
          /gpt/i.test(model.id),
      )
      .map((model) => encodePiModelRef(model).id),
  );
}

export function withPiFast(
  catalog: HarnessModelCatalog,
  supported: ReadonlySet<string>,
): HarnessModelCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) =>
      supported.has(model.ref.id)
        ? { ...model, fastModel: encodePiModelRef({ ...decodePiModelRef(model.ref), fast: true }) }
        : model,
    ),
  };
}

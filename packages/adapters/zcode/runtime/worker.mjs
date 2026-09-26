// Built against the pinned ZCode source by tools/zcode-runtime/build.mjs.
// All account, entitlement, storage and Agent behavior stays in ZCode services.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  ensureDeviceMid,
} from "@zcode/services/node";
import {
  createZCodeAgentConnectionScope,
  IZCodeAgentService,
  IModelSelectionService,
  IClientConfigService,
} from "@zcode/services";
import { requestCaptcha } from "./captcha.mjs";
import { completeNewModelSelection } from "@zcode/provider";

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// Native services log to console; stdout belongs exclusively to this transport.
for (const name of ["log", "info", "debug", "warn"])
  console[name] = (...args) => console.error(...args);
const calls = new Set([
  "createSession",
  "resumeSession",
  "readSession",
  "readSessionEvents",
  "closeSession",
  "setModel",
  "setThoughtLevel",
  "setMode",
  "compactSession",
  "goalSession",
  "getTaskTokenUsage",
  "listSessionSubagents",
  "readSessionMessages",
  "readWorkspacePresentation",
  "sendConversationCommandV4",
  "subscribeConversationV4",
  "unsubscribeConversationV4",
  "conversationRowsRangeV4",
  "conversationFileChangesV4",
]);
const events = new Set(["onDynamicSessionEvent", "onDynamicConversationFrame"]);
const subscriptions = new Map();
let services, scope, agent, workspace, closing;

async function initialize(params) {
  if (services) throw new Error("Already initialized");
  workspace = { workspacePath: params.cwd };
  await ensureDeviceMid();
  services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath: params.providerConfig,
    serviceAuthorityMode: "standalone-server",
    resolveRuntimeProviderHeaders: async (request, signal) => {
      if (request.accountAccess?.mode !== "start-plan" || request.reason !== "model-request")
        return {};
      if (!params.verificationSupported)
        throw new Error("ZCode Start Plan requires a local verification browser");
      const config = (await services.get(IClientConfigService).getSnapshot()).captcha;
      if (!config) throw new Error("ZCode did not provide CAPTCHA configuration");
      return requestCaptcha(config, signal, write);
    },
    // 原生 Services 会注入当前生效的 Provider 配置；不能用 command.env 覆盖成旧 bundle。
    zcodeAgentCommandResolver: (context) => ({
      command: params.nativeCommand,
      args: params.nativeArguments,
      cwd: context.workspacePath,
    }),
  });
  scope = createZCodeAgentConnectionScope(services.get(IZCodeAgentService), {
    connectionId: `codexhost-${randomUUID()}`,
    clientMode: "desktop-continuous",
    role: "terminal-client",
  });
  agent = scope.service;
  const hello = await agent.helloConversationV4();
  await agent.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: hello.protocolVersion,
    clientId: params.clientId,
    clientKind: "desktop",
    appVersion: "3.14.3",
  });
  return {
    protocol: 1,
    version: "3.14.3",
    sourceRevision: "29628c9acdb81b703bbd4080c207a0e7ce5e276e",
  };
}

async function catalog() {
  const view = await services.get(IModelSelectionService).getView();
  // Provider views include secrets. Project an explicit allowlist before crossing IPC.
  const models = view.providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.config.enabled)
      .map((model) => {
        const levels = model.config.optionSpecs.reasoningLevel.values;
        const nativeDefault = completeNewModelSelection(view, {
          providerId: provider.providerId,
          modelId: model.modelId,
        });
        return {
          ref: { providerId: provider.providerId, modelId: model.modelId },
          label: `${provider.providerName || provider.providerId} / ${model.modelId}`,
          reasoning: {
            enabled: levels.length > 0,
            levels: levels.map((value) => ({ value, label: value })),
            ...(nativeDefault?.options?.reasoningLevel
              ? { defaultLevel: nativeDefault.options.reasoningLevel }
              : {}),
          },
        };
      }),
  );
  const current = view.preferredSelection;
  const presentation = await agent.readWorkspacePresentation(workspace);
  return {
    model: { available: models, ...(current ? { current } : {}) },
    thoughtLevel: {
      enabled: Boolean(current?.options?.reasoningLevel),
      ...(current?.options?.reasoningLevel ? { current: current.options.reasoningLevel } : {}),
      available: [],
    },
    mode: { current: presentation.mode },
  };
}

async function dispatch(request) {
  if (request.method === "initialize") return initialize(request.params);
  if (!agent || closing) throw new Error("Worker is not available");
  if (request.method === "catalog") return catalog();
  if (request.method === "listen") {
    const { key, event, params } = request.params;
    if (!events.has(event) || subscriptions.has(key)) throw new Error("Invalid subscription");
    const dispose = agent[event]({ ...params, ...workspace })((value) =>
      write({ event, key, value }),
    );
    subscriptions.set(key, dispose);
    return null;
  }
  if (request.method === "unlisten") {
    subscriptions.get(request.params.key)?.dispose();
    subscriptions.delete(request.params.key);
    return null;
  }
  if (!calls.has(request.method)) throw new Error("Unsupported service method");
  return agent[request.method]({ ...request.params, ...workspace });
}

async function close() {
  return (closing ??= (async () => {
    for (const disposable of subscriptions.values()) disposable.dispose();
    subscriptions.clear();
    await scope?.dispose();
    if (services) await disposeServiceResourcesAndWait(services);
  })());
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (!Number.isSafeInteger(request.id) || typeof request.method !== "string") throw new Error();
  } catch {
    void close().finally(() => process.exit(1));
    return;
  }
  if (request.method === "close") {
    void close().then(() => {
      write({ id: request.id, result: null });
      process.exit(0);
    });
    return;
  }
  void dispatch(request).then(
    (result) => write({ id: request.id, result: result ?? null }),
    (error) => {
      // Native errors may contain request headers or provider config. Never forward text/stacks.
      const schemaPaths = Array.isArray(error?.issues)
        ? error.issues
            .slice(0, 4)
            .map((issue) =>
              issue.path
                .filter(
                  (part) =>
                    typeof part === "number" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(part)),
                )
                .join("."),
            )
        : [];
      write({
        id: request.id,
        error: {
          code:
            typeof error?.code === "number" || typeof error?.code === "string"
              ? error.code
              : schemaPaths.length
                ? "protocolError"
                : "nativeFailure",
          schemaPaths,
        },
      });
    },
  );
});
input.on("close", () => {
  void close().finally(() => process.exit(0));
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });

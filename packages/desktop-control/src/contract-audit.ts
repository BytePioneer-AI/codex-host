import { CdpClient, getCdpBrowserVersion, type CdpBrowserVersion } from "./cdp-client.js";
import {
  inspectElectronWebContents,
  selectRendererWebContents,
  waitForInspectorTarget,
  type ElectronRendererSummary,
} from "./renderer-control-session.js";

export const DESKTOP_CONTRACT_AUDIT_SCHEMA_VERSION = 1 as const;

export type ContractAuditCardinalityState = "unique" | "missing" | "ambiguous" | "inactive";

export interface RendererContractAuditInspection {
  schemaVersion: 1;
  composer: {
    composerCount: number;
    visibleComposerCount: number;
    activeComposerCount: number;
    modelCandidateCount: number;
    verifiedModelCandidateCount: number;
    permissionCandidateCount: number;
    verifiedPermissionCandidateCount: number;
    contextUsageCandidateCount: number;
    verifiedContextUsageCandidateCount: number;
    sendButtonCount: number;
    trailingActionOwnerCount: number;
  };
  model: {
    draftCount: number;
    conversationCount: number;
    missingCount: number;
    ambiguousCount: number;
  };
  settings: {
    headerCount: number;
    visibleHeaderCount: number;
    insertionPointCount: number;
  };
  sidebar: {
    rowCount: number;
    titleOwnerCount: number;
    resolvedThreadCount: number;
    ambiguousThreadCount: number;
  };
  transcript: {
    turnCount: number;
    itemNodeCount: number;
    identifiedItemCount: number;
    textBodyCount: number;
    textBodyOwnerCount: number;
  };
  fork: {
    annotatedResponseCount: number;
    candidateButtonCount: number;
    verifiedButtonCount: number;
  };
  production: {
    bindingPresent: boolean;
    adapterState: "installing" | "ready" | "unsupported" | "absent";
    adapterReason: string;
    titlePolicyState: "ready" | "absent" | "unknown";
    draftPrewarmPolicyState: "ready" | "absent" | "unknown";
  };
}

export interface DesktopContractAuditObservation {
  schemaVersion: typeof DESKTOP_CONTRACT_AUDIT_SCHEMA_VERSION;
  browser: {
    browser: string;
    protocolVersion: string;
  };
  renderer: ElectronRendererSummary;
  contracts: RendererContractAuditInspection;
}

export interface InspectDesktopContractsOptions {
  endpoint: string;
  inspectorEndpoint: string;
  rendererAuditSource: string;
  timeoutMs?: number;
}

interface RecordValue {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictKeys(value: RecordValue, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function integerRecord<T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string,
): { [K in T[number]]: number } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  strictKeys(value, keys, label);
  return Object.fromEntries(keys.map((key) => [key, integer(value[key], `${label}.${key}`)])) as {
    [K in T[number]]: number;
  };
}

export function validateRendererContractAuditInspection(
  value: unknown,
): RendererContractAuditInspection {
  if (!isRecord(value)) throw new Error("Renderer contract audit must be an object");
  strictKeys(
    value,
    [
      "schemaVersion",
      "composer",
      "model",
      "settings",
      "sidebar",
      "transcript",
      "fork",
      "production",
    ],
    "Renderer contract audit",
  );
  if (value.schemaVersion !== 1) throw new Error("Renderer contract audit schema is unsupported");
  const production = value.production;
  if (!isRecord(production)) throw new Error("Renderer contract audit production state is invalid");
  strictKeys(
    production,
    [
      "bindingPresent",
      "adapterState",
      "adapterReason",
      "titlePolicyState",
      "draftPrewarmPolicyState",
    ],
    "Renderer contract audit production state",
  );
  if (
    typeof production.bindingPresent !== "boolean" ||
    !["installing", "ready", "unsupported", "absent"].includes(String(production.adapterState)) ||
    typeof production.adapterReason !== "string" ||
    production.adapterReason.length > 64 ||
    !["ready", "absent", "unknown"].includes(String(production.titlePolicyState)) ||
    !["ready", "absent", "unknown"].includes(String(production.draftPrewarmPolicyState))
  ) {
    throw new Error("Renderer contract audit production state is invalid");
  }
  return {
    schemaVersion: 1,
    composer: integerRecord(
      value.composer,
      [
        "composerCount",
        "visibleComposerCount",
        "activeComposerCount",
        "modelCandidateCount",
        "verifiedModelCandidateCount",
        "permissionCandidateCount",
        "verifiedPermissionCandidateCount",
        "contextUsageCandidateCount",
        "verifiedContextUsageCandidateCount",
        "sendButtonCount",
        "trailingActionOwnerCount",
      ] as const,
      "Renderer composer contract",
    ),
    model: integerRecord(
      value.model,
      ["draftCount", "conversationCount", "missingCount", "ambiguousCount"] as const,
      "Renderer model contract",
    ),
    settings: integerRecord(
      value.settings,
      ["headerCount", "visibleHeaderCount", "insertionPointCount"] as const,
      "Renderer settings contract",
    ),
    sidebar: integerRecord(
      value.sidebar,
      ["rowCount", "titleOwnerCount", "resolvedThreadCount", "ambiguousThreadCount"] as const,
      "Renderer sidebar contract",
    ),
    transcript: integerRecord(
      value.transcript,
      [
        "turnCount",
        "itemNodeCount",
        "identifiedItemCount",
        "textBodyCount",
        "textBodyOwnerCount",
      ] as const,
      "Renderer transcript contract",
    ),
    fork: integerRecord(
      value.fork,
      ["annotatedResponseCount", "candidateButtonCount", "verifiedButtonCount"] as const,
      "Renderer fork contract",
    ),
    production: {
      bindingPresent: production.bindingPresent,
      adapterState:
        production.adapterState as RendererContractAuditInspection["production"]["adapterState"],
      adapterReason: production.adapterReason,
      titlePolicyState:
        production.titlePolicyState as RendererContractAuditInspection["production"]["titlePolicyState"],
      draftPrewarmPolicyState:
        production.draftPrewarmPolicyState as RendererContractAuditInspection["production"]["draftPrewarmPolicyState"],
    },
  };
}

const electronModuleExpression = `(() => {
  const mainModule = process.mainModule;
  if (mainModule != null && typeof mainModule.require === 'function') {
    return mainModule.require('electron');
  }
  const { createRequire } = process.getBuiltinModule('module');
  return createRequire(process.execPath)('electron');
})()`;

async function executeReadOnlyAudit(
  inspector: Pick<CdpClient, "evaluate">,
  rendererWebContentsId: number,
  source: string,
): Promise<unknown> {
  return inspector.evaluate<unknown>(`(async () => {
    const { webContents } = ${electronModuleExpression};
    const contents = webContents.fromId(${rendererWebContentsId});
    if (contents == null || contents.isDestroyed()) throw new Error('Renderer webContents is unavailable');
    return contents.executeJavaScript(${JSON.stringify(`(() => {
      const previous = window.__codexhostContractAuditV1;
      ${source}
      try {
        const audit = window.__codexhostContractAuditV1;
        if (audit == null || typeof audit.inspect !== 'function') {
          throw new Error('Renderer contract audit entry is unavailable');
        }
        return audit.inspect();
      } finally {
        if (previous === undefined) delete window.__codexhostContractAuditV1;
        else window.__codexhostContractAuditV1 = previous;
      }
    })()`)}, true);
  })()`);
}

function browserIdentity(version: CdpBrowserVersion): DesktopContractAuditObservation["browser"] {
  return { browser: version.browser, protocolVersion: version.protocolVersion };
}

export async function inspectDesktopContracts(
  options: InspectDesktopContractsOptions,
): Promise<DesktopContractAuditObservation> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const [browser, inspectorTarget] = await Promise.all([
    getCdpBrowserVersion(options.endpoint),
    waitForInspectorTarget(options.inspectorEndpoint, { timeoutMs }),
  ]);
  const inspector = await CdpClient.connect(inspectorTarget.webSocketDebuggerUrl);
  try {
    await inspector.command("Runtime.enable");
    const inventory = await inspectElectronWebContents(inspector);
    const renderer = selectRendererWebContents(inventory);
    if (!renderer) throw new Error("Contract audit did not find a primary Renderer");
    const contracts = validateRendererContractAuditInspection(
      await executeReadOnlyAudit(inspector, renderer.id, options.rendererAuditSource),
    );
    return {
      schemaVersion: DESKTOP_CONTRACT_AUDIT_SCHEMA_VERSION,
      browser: browserIdentity(browser),
      renderer,
      contracts,
    };
  } finally {
    inspector.close();
  }
}

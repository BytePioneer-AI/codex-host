import { inspectScopedDraftModelBinding } from "@codexhost/desktop-control/renderer-bindings";
import {
  CODEX_COMPOSER_SELECTOR,
  inspectRendererComposerContract,
  type RendererComposerContractInspection,
} from "./renderer-composer-dom.js";
import {
  inspectComposerCodexUsageGate,
  type RendererCodexUsageGateInspection,
} from "./renderer-codex-usage-gate.js";
import {
  inspectRendererForkContract,
  type RendererForkContractInspection,
} from "./renderer-fork-control.js";
import {
  inspectRendererSidebarContract,
  type RendererSidebarContractInspection,
} from "./renderer-sidebar-agent-icons.js";
import {
  inspectRendererTranscriptContract,
  type RendererTranscriptContractInspection,
} from "./renderer-transcript-dom.js";
import {
  inspectRendererSettingsContract,
  type RendererSettingsContractInspection,
} from "./settings/trigger.js";
import {
  findComposerModelTarget,
  inspectComposerModelContract,
} from "./versioned-renderer-adapter.js";

export const RENDERER_CONTRACT_AUDIT_SCHEMA_VERSION = 1 as const;

export interface RendererContractAuditApi {
  inspect(): RendererContractAuditInspection;
}

export interface RendererContractAuditInspection {
  schemaVersion: typeof RENDERER_CONTRACT_AUDIT_SCHEMA_VERSION;
  composer: RendererComposerContractInspection;
  model: {
    draftCount: number;
    conversationCount: number;
    missingCount: number;
    ambiguousCount: number;
    writerBoundCount: number;
    writerAmbiguousCount: number;
    creationModeBoundCount: number;
    creationModeAmbiguousCount: number;
    creationModeUnmarkableCount: number;
  };
  settings: RendererSettingsContractInspection;
  sidebar: RendererSidebarContractInspection;
  transcript: RendererTranscriptContractInspection;
  codexUsageGate: RendererCodexUsageGateInspection & { composerCount: number };
  fork: RendererForkContractInspection;
  production: {
    bindingPresent: boolean;
    adapterState: "installing" | "ready" | "unsupported" | "absent";
    adapterReason: string;
    titlePolicyState: "ready" | "absent" | "unknown";
    draftPrewarmPolicyState: "ready" | "absent" | "unknown";
  };
}

declare global {
  interface Window {
    __codexhostContractAuditV1?: RendererContractAuditApi;
  }
}

function modelCounts(composers: readonly Element[]): RendererContractAuditInspection["model"] {
  const counts = {
    draftCount: 0,
    conversationCount: 0,
    missingCount: 0,
    ambiguousCount: 0,
    writerBoundCount: 0,
    writerAmbiguousCount: 0,
    creationModeBoundCount: 0,
    creationModeAmbiguousCount: 0,
    creationModeUnmarkableCount: 0,
  };
  for (const composer of composers) {
    const target = findComposerModelTarget(composer);
    const identity = inspectComposerModelContract(composer, target);
    counts[`${identity}Count`] += 1;
    if (identity !== "draft" || typeof target?.[1] !== "string") continue;
    const { writer, creationMode } = inspectScopedDraftModelBinding(composer, target[1]);
    if (writer === "bound") counts.writerBoundCount += 1;
    if (writer === "ambiguous") counts.writerAmbiguousCount += 1;
    if (creationMode === "bound") counts.creationModeBoundCount += 1;
    if (creationMode === "ambiguous") counts.creationModeAmbiguousCount += 1;
    if (creationMode === "unmarkable") counts.creationModeUnmarkableCount += 1;
  }
  return counts;
}

/** Composers with an editor; each should expose one owner and one reserve gate. */
function codexUsageGateCounts(
  composers: readonly Element[],
): RendererCodexUsageGateInspection & { composerCount: number } {
  const editable = composers.filter((composer) =>
    composer.querySelector('[contenteditable="true"][role="textbox"]'),
  );
  const counts = {
    composerCount: editable.length,
    ownerCount: 0,
    reserveGateCount: 0,
    accountGateCount: 0,
  };
  for (const composer of editable) {
    const inspection = inspectComposerCodexUsageGate(composer);
    counts.ownerCount += inspection.ownerCount;
    counts.reserveGateCount += inspection.reserveGateCount;
    counts.accountGateCount += inspection.accountGateCount;
  }
  return counts;
}

export function inspectRendererContracts(
  ownerWindow: Window = window,
): RendererContractAuditInspection {
  const composers = [...ownerWindow.document.querySelectorAll<Element>(CODEX_COMPOSER_SELECTOR)];
  const binding = ownerWindow.__codexhostRendererBindingProbeV1;
  const status = binding?.status();
  const adapterState = status?.adapter.state ?? "absent";
  const titlePolicy = ownerWindow.__codexhostMainProcessTitlePolicyV1;
  const draftPolicy = ownerWindow.__codexhostDraftPrewarmPolicyV1;
  return {
    schemaVersion: RENDERER_CONTRACT_AUDIT_SCHEMA_VERSION,
    composer: inspectRendererComposerContract(ownerWindow.document),
    model: modelCounts(composers),
    settings: inspectRendererSettingsContract(ownerWindow.document),
    sidebar: inspectRendererSidebarContract(ownerWindow.document),
    transcript: inspectRendererTranscriptContract(ownerWindow.document),
    codexUsageGate: codexUsageGateCounts(composers),
    fork: inspectRendererForkContract(ownerWindow.document),
    production: {
      bindingPresent: binding !== undefined,
      adapterState,
      adapterReason: status?.adapter.state ?? "absent",
      titlePolicyState:
        titlePolicy === undefined ? "absent" : titlePolicy.state === "ready" ? "ready" : "unknown",
      draftPrewarmPolicyState:
        draftPolicy === undefined ? "absent" : draftPolicy.state === "ready" ? "ready" : "unknown",
    },
  };
}

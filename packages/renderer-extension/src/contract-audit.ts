import { findScopedDraftModelBinding } from "@codexhost/desktop-control/renderer-bindings";

import {
  CODEX_COMPOSER_SELECTOR,
  contractElementVisible,
  inspectRendererComposerContract,
  type RendererComposerContractInspection,
} from "./renderer-composer-dom.js";
import {
  inspectComposerCodexUsageGate,
  type RendererCodexUsageGateInspection,
} from "./renderer-codex-usage-gate.js";
import { isOrbitComposer } from "./renderer-composer-kind.js";
import { hasNativeComposerRequest } from "./renderer-composer-request.js";
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
  findActivePrewarmTargets,
  findComposerDomIdentity,
  findComposerModelTarget,
  inspectComposerModelContract,
  type RendererComposerModelContractState,
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
  };
  draftHarnessBinding: {
    visibleDraftCount: number;
    boundCount: number;
    missingCreationModeCount: number;
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

function modelCounts(states: readonly RendererComposerModelContractState[]): {
  draftCount: number;
  conversationCount: number;
  missingCount: number;
  ambiguousCount: number;
} {
  return {
    draftCount: states.filter((state) => state === "draft").length,
    conversationCount: states.filter((state) => state === "conversation").length,
    missingCount: states.filter((state) => state === "missing").length,
    ambiguousCount: states.filter((state) => state === "ambiguous").length,
  };
}

function draftHarnessBindingCounts(
  composers: readonly Element[],
  rpcPolicyPublished: boolean,
): RendererContractAuditInspection["draftHarnessBinding"] {
  const counts = { visibleDraftCount: 0, boundCount: 0, missingCreationModeCount: 0 };
  for (const composer of composers) {
    if (
      !contractElementVisible(composer) ||
      hasNativeComposerRequest(composer) ||
      isOrbitComposer(composer)
    )
      continue;
    const target = findComposerModelTarget(composer);
    if (
      target?.[0] === "conversation" ||
      (target?.[0] !== "default" && findComposerDomIdentity(composer).kind !== "draft")
    )
      continue;
    counts.visibleDraftCount += 1;
    const binding =
      typeof target?.[1] === "string" ? findScopedDraftModelBinding(composer, target[1]) : null;
    if (!binding) continue;
    counts.boundCount += 1;
    // A published policy or the absence of native request ownership requires RPC-grade evidence.
    if (
      (rpcPolicyPublished || findActivePrewarmTargets(composer).length === 0) &&
      binding.creationModes?.length !== 1
    ) {
      counts.missingCreationModeCount += 1;
    }
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
    model: modelCounts(composers.map(inspectComposerModelContract)),
    draftHarnessBinding: draftHarnessBindingCounts(
      composers,
      draftPolicy?.requiresCreationMode === true,
    ),
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

import {
  CODEX_COMPOSER_SELECTOR,
  inspectRendererComposerContract,
  type RendererComposerContractInspection,
} from "./renderer-composer-dom.js";
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
  settings: RendererSettingsContractInspection;
  sidebar: RendererSidebarContractInspection;
  transcript: RendererTranscriptContractInspection;
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
    settings: inspectRendererSettingsContract(ownerWindow.document),
    sidebar: inspectRendererSidebarContract(ownerWindow.document),
    transcript: inspectRendererTranscriptContract(ownerWindow.document),
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

import {
  peerIdFromRemoteHostId,
  remotePeerHarnessIconPath,
  remotePeerHarnessPresentationPath,
} from "@codexhost/shared-contracts";

export interface HarnessIconSources {
  readonly src: string;
  readonly presentationUrl: string;
}

/** Resolve local or remote-peer Harness icon and presentation URLs; Codex always uses local assets. */
export function harnessIconSources(harnessId: string, hostId?: string): HarnessIconSources {
  const peerId =
    hostId !== undefined && harnessId !== "codex" ? peerIdFromRemoteHostId(hostId) : undefined;
  if (peerId !== undefined) {
    return {
      src: remotePeerHarnessIconPath(peerId, harnessId),
      presentationUrl: remotePeerHarnessPresentationPath(peerId),
    };
  }
  return {
    src: `/harness-icons/${encodeURIComponent(harnessId)}`,
    presentationUrl: "/harness-icons/presentation.json",
  };
}

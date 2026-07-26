import { packageMetadata as piAdapter } from "@codexhost/adapter-pi";
import { packageMetadata as desktopControl } from "@codexhost/desktop-control";
import { packageMetadata as mappingStore } from "@codexhost/mapping-store";
import { packageMetadata as protocolCore } from "@codexhost/protocol-core";

export const packageMetadata = {
  name: "@codexhost/host-runtime",
  dependencies: [protocolCore.name, desktopControl.name, mappingStore.name, piAdapter.name],
} as const;

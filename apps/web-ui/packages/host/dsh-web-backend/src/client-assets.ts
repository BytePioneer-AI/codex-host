/** The native browser asset service exposed to the embedding Web carrier. */
import { Context } from "@deepseek-ai/cordis";
import ClientModules, { bootInjections } from "@deepseek-ai/dsh-client-modules";
import { renderIndexInjections } from "@deepseek-ai/dsh-host-webserver";

export interface ClientSource {
  id: string;
  clientPath: string;
  manifest: { inject?: string[]; external?: string[]; immediately?: boolean };
}
export interface ClientGraph {
  rev: string;
  entries: {
    id: string;
    url: string;
    rev: string;
    inject?: string[];
    immediately?: boolean;
    external?: string[];
  }[];
  batches: { phase: "bootstrap" | "application"; url: string; rev: string; entries: string[] }[];
}
export interface ClientAssets {
  graph(): ClientGraph;
  rebuilt(id: string): string | undefined;
  fetchBundle(request: Request): Promise<Response>;
  readBundle(url: string): { body: Buffer; contentType: string } | undefined;
}

/** Packaging and built-in recovery use the same composer without executing any Host entries. */
export function createClientAssets(sources: readonly ClientSource[]): ClientAssets {
  return new ClientModules(new Context(), { sources, registerWeb: false });
}

export function renderClientBoot(html: string, graph: ClientGraph): string {
  return renderIndexInjections(html, bootInjections(graph));
}

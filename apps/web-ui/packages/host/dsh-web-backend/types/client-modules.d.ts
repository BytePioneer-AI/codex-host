/** Host-side API of the vendored client module service. */
import type { Context } from "@deepseek-ai/cordis";
import type { ClientAssets, ClientGraph, ClientSource } from "../src/client-assets.ts";
export default class ClientModules implements ClientAssets {
  constructor(ctx: Context, options?: { sources?: readonly ClientSource[]; registerWeb?: boolean });
  graph(): ClientGraph;
  rebuilt(id: string): string | undefined;
  fetchBundle(request: Request): Promise<Response>;
  readBundle(url: string): { body: Buffer; contentType: string } | undefined;
}
export function bootInjections(graph: ClientGraph): unknown[];

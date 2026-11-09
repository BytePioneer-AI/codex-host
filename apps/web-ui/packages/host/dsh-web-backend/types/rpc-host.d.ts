import type { Context } from "./cordis.d.ts";

export interface SharedFetchHandler {
  fetch(request: Request): Promise<Response>;
}

export class HostConnectionService {
  constructor(ctx: Context, trustedHosts: readonly string[], browserAuth: unknown);
  createSharedFetchHandler(channel: "/api"): SharedFetchHandler;
}

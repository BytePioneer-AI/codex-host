import { RendererRequestTransportError } from "./renderer-request-sender.js";

/** Host requests through the Web server's authenticated client channel. */
export function webRequestManager(): {
  sendRequest(method: string, params: unknown, options?: unknown): Promise<unknown>;
} {
  return {
    async sendRequest(method, params, options) {
      const signal = options instanceof AbortSignal ? options : undefined;
      const request: RequestInit = {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params: params ?? {} }),
        ...(signal ? { signal } : {}),
      };
      let response: Response;
      try {
        response = await fetch("api/ch/v1/rpc", request);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new RendererRequestTransportError(error);
      }
      let reply: {
        result?: unknown;
        error?: { code?: number; message?: string };
      } | null;
      try {
        reply = await response.json();
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new RendererRequestTransportError(error);
      }
      if (!response.ok || !reply || reply.error) {
        throw Object.assign(new Error(reply?.error?.message ?? `HTTP ${response.status}`), {
          code: reply?.error?.code,
        });
      }
      return reply.result;
    },
  };
}

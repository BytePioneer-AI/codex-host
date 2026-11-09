import type { DshStreamInputWindow } from "./stream-input.ts";

/** The Typert gateway surface the backend forwards to. */
export interface GatewayService {
  readonly wireStream: {
    open(
      endpoint: string,
      payload: unknown,
      uplink: AsyncIterable<unknown>,
      peer: undefined,
      signal: AbortSignal,
      window?: DshStreamInputWindow,
    ): Promise<AsyncIterable<unknown>>;
    failure(error: unknown): { code: string; message: string; details: object };
  };
}

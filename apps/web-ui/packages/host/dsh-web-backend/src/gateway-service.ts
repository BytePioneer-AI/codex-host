/** The Typert gateway surface the backend forwards to. */
export interface GatewayService {
  readonly wireStream: {
    open(
      endpoint: string,
      payload: unknown,
      uplink: AsyncIterable<unknown>,
      peer: undefined,
      signal: AbortSignal,
    ): Promise<AsyncIterable<unknown>>;
    failure(error: unknown): { code: string; message: string; details: object };
  };
}

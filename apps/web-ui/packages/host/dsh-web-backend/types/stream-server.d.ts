/** Public inbox surface used by the embedded Web mux. */
export declare class UplinkInbox implements AsyncIterable<unknown> {
  constructor(
    maxBytes: number,
    endpoint: string,
    onViolation: (failure: { code: string; message: string; details: object }) => void,
  );
  push(value: unknown, frameBytes: number): void;
  end(): void;
  return(): Promise<IteratorResult<unknown>>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

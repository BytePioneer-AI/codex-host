/** Bounded Remote input shared by the embedded DSH Gateway and the Web mux. */
import { UplinkInbox } from "@deepseek-ai/dsh-api-gateway/stream-server";

/** Complete encoded-frame capacity advertised to a duplex Remote client. */
export interface DshStreamInputWindow {
  readonly maxBytes: number;
  readonly frameOverheadBytes: number;
}

/** Bounded, cancellable input queue shared with the upstream DSH mux. */
export interface DshStreamUplink extends AsyncIterable<unknown> {
  push(value: unknown, frameBytes: number): void;
  end(): void;
  return(): Promise<IteratorResult<unknown>>;
}

/** Create the upstream inbox without exposing DSH runtime types to Web. */
export function createDshStreamUplink(
  maxBytes: number,
  endpoint: string,
  onViolation: (failure: { code: string; message: string; details: object }) => void,
): DshStreamUplink {
  return new UplinkInbox(maxBytes, endpoint, onViolation);
}

/** Input and carrier budget of one physical Web mux stream. */
export interface DshStreamInput {
  readonly items: AsyncIterable<unknown>;
  readonly window: DshStreamInputWindow;
}

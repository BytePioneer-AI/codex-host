/** A bounded Host RPC failure returned through a non-RPC client endpoint. */
export class ClientChannelRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

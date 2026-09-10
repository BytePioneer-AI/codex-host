export class RendererMethodUnavailableError extends Error {
  readonly code = -32601;

  constructor(
    readonly method: string,
    cause: unknown,
  ) {
    super(`${method} is unsupported on this Host connection`, { cause });
    this.name = "RendererMethodUnavailableError";
  }
}

function isUnsupportedMethod(error: unknown, method: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? error.message : undefined;
  return (
    code === -32601 ||
    (code === -32600 &&
      typeof message === "string" &&
      message.startsWith(`Invalid request: unknown variant \`${method}\``))
  );
}

/** One sender per request client. Only explicit method absence is remembered;
 * successes, params, Harness availability and transient failures are not cached. */
export function createRendererRequestSender(
  send: (method: string, params: unknown) => Promise<unknown> | unknown,
): (method: string, params: unknown) => Promise<unknown> {
  const unsupported = new Map<string, RendererMethodUnavailableError>();
  return async (method, params) => {
    const known = unsupported.get(method);
    if (known) throw known;
    try {
      return await send(method, params);
    } catch (error) {
      if (!method.startsWith("codexhost/") || !isUnsupportedMethod(error, method)) throw error;
      const unavailable = new RendererMethodUnavailableError(method, error);
      unsupported.set(method, unavailable);
      throw unavailable;
    }
  };
}

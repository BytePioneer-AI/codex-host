export class GateCError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GateCError";
    this.code = code;
    this.details = details;
  }
}

export function asGateCError(error, code = "INTERNAL_ERROR") {
  if (error instanceof GateCError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GateCError(code, message, { cause: error });
}

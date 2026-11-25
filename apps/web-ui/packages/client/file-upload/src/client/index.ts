/** Browser background-upload Cordis service. */

import type { Context } from "@deepseek-ai/cordis";
import { FileUploadRuntime } from "./runtime.ts";
import type { FileUploadService } from "./contract.ts";

export type { FileUploadProgress, FileUploadService } from "./contract.ts";
export type { FileUploadReceiptId, FileUploadValue } from "../types.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Session-addressed browser service for staged file uploads. */
    fileUpload: FileUploadService;
  }
}

/** Keep existing Remote plugin wiring; browser file bodies use raw-byte intake. */
export const inject = ["remote"];

/**
 * Provide the browser background-upload service.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(FileUploadRuntime);
}

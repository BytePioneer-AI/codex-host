import type { DshPlugin } from "./plugin.d.ts";

export type OfficeExtension = "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx";
export type OfficeToPdfPriority = "foreground" | "background";
export type OfficeToPdfErrorCode =
  | "downloading"
  | "input-too-large"
  | "output-too-large"
  | "invalid-document"
  | "unsupported-format"
  | "invalid-output"
  | "timeout"
  | "unavailable"
  | "failed"
  | "busy"
  | "source-changed";

export class OfficeToPdfError extends Error {
  readonly code: OfficeToPdfErrorCode;
  constructor(code: OfficeToPdfErrorCode, message: string, options?: ErrorOptions);
}

export interface OfficeToPdfRequest {
  readonly extension: OfficeExtension;
  readonly priority: OfficeToPdfPriority;
  readonly source: {
    readonly key: string;
    readonly version: string;
    readonly bytes?: number;
    read(
      signal: AbortSignal,
      maxBytes: number,
    ): Promise<{ readonly bytes: Uint8Array; readonly version: string }>;
  };
}

export interface OfficeToPdfResult {
  readonly pdf: Uint8Array;
  readonly missingFonts: string[];
  readonly cacheKey: string;
  readonly generation: string;
}

export interface OfficeToPdfService {
  convert(request: OfficeToPdfRequest, signal: AbortSignal): Promise<OfficeToPdfResult>;
}

declare const plugin: DshPlugin;
export default plugin;

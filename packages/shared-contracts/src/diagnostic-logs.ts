import { z } from "zod";

export const DIAGNOSTIC_LOG_LIST_METHOD = "codexhost/logs/list";
export const DIAGNOSTIC_LOG_EXPORT_METHOD = "codexhost/logs/export";
export const diagnosticLogScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("harness"), harnessId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("runtime") }).strict(),
]);
export const diagnosticLogListResultSchema = z.array(diagnosticLogScopeSchema);
export const diagnosticLogExportParamsSchema = diagnosticLogScopeSchema;
export type DiagnosticLogScope = z.infer<typeof diagnosticLogScopeSchema>;
export const diagnosticLogExportResultSchema = z.object({
  fileName: z.string().min(1),
  data: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type DiagnosticLogExportResult = z.infer<typeof diagnosticLogExportResultSchema>;

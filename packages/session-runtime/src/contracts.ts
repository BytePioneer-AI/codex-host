import type { HarnessInspection, HarnessPermissionModeCatalog } from "@codexhost/harness-adapter";

export type Inspection = HarnessInspection;
export type PermissionModeCatalog = HarnessPermissionModeCatalog;

/** JSON/file persistence used by the shared DSH session log. */
export interface SessionDataStore {
  path(...parts: string[]): string;
  readJson<T>(relative: string, fallback: T): T;
  writeJson(relative: string, value: unknown): void;
  readLines<T>(relative: string): T[];
  writeLines(relative: string, values: readonly unknown[]): void;
  appendLine(relative: string, value: unknown): void;
}
/** Bounded live sink for one Session's projected frames. */
export interface SessionSink {
  readonly id: string;
  readonly closed: boolean;
  push(value: unknown): void;
  end(): void;
  fail(code: string, message: string): void;
  onClose(listener: () => void): void;
}
export class SessionRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: object = {},
  ) {
    super(message);
  }
}

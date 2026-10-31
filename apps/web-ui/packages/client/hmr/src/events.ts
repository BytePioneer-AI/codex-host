/**
 * Wire protocol of the `/plugins/events` SSE channel — single source for
 * both halves of this package. Frames still cross a wire boundary: the
 * browser half validates them at its JSON parse point; sharing the type keeps
 * the two ends from drifting, not from parsing.
 */

import type { WebBootGraph } from "@deepseek-ai/dsh-client-modules";

/**
 * One SSE frame: the settled graph on connection or change, one rebuilt bundle notice, or a
 * rebuilt shell (CodexHost: the statically linked shell cannot be swapped, so the page reloads).
 */
export type PluginsEventFrame =
  | { type: "graph"; graph: WebBootGraph }
  | { type: "rebuilt"; id: string; rev: string }
  | { type: "shell" };

/** Browser wire-parse result: known frame, forward-compatible unknown type, or malformed payload. */
export type PluginsEventParseResult =
  | {
      kind: "frame";
      frame: { type: "graph"; graph: unknown } | Exclude<PluginsEventFrame, { type: "graph" }>;
    }
  | { kind: "unknown" }
  | { kind: "invalid" };

/**
 * Validate the frame envelope; the module controller parses the complete graph before updating its index.
 * @param value - Parsed JSON value from the EventSource message.
 * @returns the known frame, an unknown-type marker, or an invalid marker.
 */
export function parsePluginsEventFrame(value: unknown): PluginsEventParseResult {
  if (typeof value !== "object" || value === null) return { kind: "invalid" };
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "rebuilt":
      return typeof record.id === "string" && typeof record.rev === "string"
        ? { kind: "frame", frame: { type: "rebuilt", id: record.id, rev: record.rev } }
        : { kind: "invalid" };
    case "shell":
      return { kind: "frame", frame: { type: "shell" } };
    case "graph":
      return typeof record.graph === "object" && record.graph !== null
        ? { kind: "frame", frame: { type: "graph", graph: record.graph } }
        : { kind: "invalid" };
    default:
      return typeof record.type === "string" ? { kind: "unknown" } : { kind: "invalid" };
  }
}

/** System SSE endpoint pushing graph/rebuilt frames (wire protocol constant). */
export const EVENTS_ENDPOINT = "/plugins/events";

/** Document-relative form of {@link EVENTS_ENDPOINT} used by the browser half. */
export const EVENTS_ROUTE = EVENTS_ENDPOINT.slice(1);

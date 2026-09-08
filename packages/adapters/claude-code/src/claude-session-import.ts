import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { HarnessSessionImportSource } from "@codexhost/harness-adapter";
import {
  HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH,
  harnessSessionImportCandidateSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import type { ClaudeSessionMetadata } from "./transport.js";

export interface ClaudeSessionImportDependencies {
  getSessionInfo(input: { sessionId: string }): Promise<ClaudeSessionMetadata | undefined>;
  isRunning(nativeSessionId: string): boolean;
  listSessions(): Promise<readonly ClaudeSessionMetadata[]>;
  readSessionMessages(input: { cwd: string; sessionId: string }): Promise<unknown[]>;
}

function titleFromMetadata(metadata: ClaudeSessionMetadata): string | null {
  for (const value of [metadata.customTitle, metadata.summary, metadata.firstPrompt]) {
    if (typeof value !== "string") continue;
    const title = value
      .replaceAll("\0", "")
      .trim()
      .slice(0, HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH);
    if (title) return title;
  }
  return null;
}

async function sourceFromMetadata(
  metadata: ClaudeSessionMetadata,
  isRunning: (nativeSessionId: string) => boolean,
  signal: AbortSignal,
  canonicalCwds: Map<string, Promise<string | null>>,
  preferredCwds: readonly string[] = [],
): Promise<HarnessSessionImportSource | null> {
  signal.throwIfAborted();
  if (
    typeof metadata.sessionId !== "string" ||
    metadata.sessionId.trim().length === 0 ||
    typeof metadata.lastModified !== "number" ||
    !Number.isFinite(metadata.lastModified)
  ) {
    return null;
  }

  const candidates = [
    ...preferredCwds,
    ...(typeof metadata.cwd === "string" ? [metadata.cwd] : []),
  ];
  let cwd: string | null = null;
  for (const candidate of new Set(candidates)) {
    if (!path.isAbsolute(candidate)) continue;
    let canonical = canonicalCwds.get(candidate);
    if (!canonical) {
      canonical = (async () => {
        try {
          const resolved = await realpath(candidate);
          return (await stat(resolved)).isDirectory() ? resolved : null;
        } catch {
          return null;
        }
      })();
      canonicalCwds.set(candidate, canonical);
    }
    cwd = await canonical;
    signal.throwIfAborted();
    if (cwd) break;
  }
  if (!cwd) return null;
  const nativeSessionId = metadata.sessionId.trim();
  const candidate = harnessSessionImportCandidateSchema.safeParse({
    nativeSessionId,
    cwd,
    title: titleFromMetadata(metadata),
    updatedAt: Math.floor(metadata.lastModified),
    // We know about sessions opened through this Adapter. Other Claude clients do not
    // expose a reliable cross-process ownership signal, so their activity stays unknown.
    running: isRunning(nativeSessionId) ? true : null,
  });
  const nativeRef = nativeSessionRefSchema.safeParse({
    harnessId: "claude-code",
    nativeSessionId,
    formatVersion: 1,
  });
  return candidate.success && nativeRef.success
    ? { candidate: candidate.data, nativeRef: nativeRef.data }
    : null;
}

/** Read-only native Claude Session discovery. Transcript content never leaves the SDK. */
export class ClaudeSessionImportIndex {
  readonly #dependencies: ClaudeSessionImportDependencies;
  #listing: Promise<HarnessSessionImportSource[]> | undefined;

  constructor(dependencies: ClaudeSessionImportDependencies) {
    this.#dependencies = dependencies;
  }

  list(signal: AbortSignal): Promise<HarnessSessionImportSource[]> {
    this.#listing ??= this.#scan(signal).finally(() => {
      this.#listing = undefined;
    });
    return this.#listing;
  }

  async #scan(signal: AbortSignal): Promise<HarnessSessionImportSource[]> {
    signal.throwIfAborted();
    const metadata = await this.#dependencies.listSessions();
    signal.throwIfAborted();
    const sources: HarnessSessionImportSource[] = [];
    const identities = new Set<string>();
    const canonicalCwds = new Map<string, Promise<string | null>>();
    for (const session of metadata) {
      const source = await sourceFromMetadata(
        session,
        this.#dependencies.isRunning,
        signal,
        canonicalCwds,
      );
      if (!source) continue;
      const identity = source.candidate.nativeSessionId;
      if (identities.has(identity)) {
        throw new Error(`Claude Session identity is ambiguous: ${identity}`);
      }
      identities.add(identity);
      sources.push(source);
    }
    return sources;
  }

  async resolve(
    nativeSessionId: string,
    signal: AbortSignal,
  ): Promise<HarnessSessionImportSource | null> {
    signal.throwIfAborted();
    const metadata = await this.#dependencies.getSessionInfo({ sessionId: nativeSessionId });
    signal.throwIfAborted();
    if (!metadata || metadata.sessionId !== nativeSessionId) return null;
    const preferredCwds: string[] = [];
    if (typeof metadata.cwd === "string" && path.isAbsolute(metadata.cwd)) {
      try {
        const messages = await this.#dependencies.readSessionMessages({
          cwd: metadata.cwd,
          sessionId: nativeSessionId,
        });
        signal.throwIfAborted();
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (
            typeof message !== "object" ||
            message === null ||
            Array.isArray(message) ||
            typeof (message as { cwd?: unknown }).cwd !== "string"
          ) {
            continue;
          }
          const cwd = (message as { cwd: string }).cwd;
          if (path.isAbsolute(cwd) && !preferredCwds.includes(cwd)) preferredCwds.push(cwd);
        }
      } catch {
        // Metadata remains a safe fallback when a native Transcript cannot be read.
      }
    }
    return sourceFromMetadata(
      metadata,
      this.#dependencies.isRunning,
      signal,
      new Map(),
      preferredCwds,
    );
  }
}

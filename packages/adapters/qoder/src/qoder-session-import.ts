import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  HarnessResult,
  HarnessSessionImportCapability,
  HarnessSessionImportSource,
} from "@codexhost/harness-adapter";
import {
  SessionImportScope,
  isStorageAccessError,
  sessionImportCandidate,
  sessionImportTitle,
} from "@codexhost/harness-adapter/session-import";
import {
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessSessionImportCandidate,
} from "@codexhost/shared-contracts";

import type { GetSessionInfoOptions, SDKSessionInfo } from "./qoder-sdk-types.js";

export interface QoderSessionImportDependencies {
  harnessId: HarnessId;
  displayName: string;
  /** The distribution's own SDK listing, so history and import stay in one store. */
  listSessions: () => Promise<SDKSessionInfo[]>;
  getSessionInfo: (
    sessionId: string,
    options?: GetSessionInfoOptions,
  ) => Promise<SDKSessionInfo | undefined>;
}

/**
 * Adapter-owned discovery through the Qoder SDK's read-only Session listing. It never starts
 * qodercli, sends a Turn or writes a transcript; resume stays the SDK's `resume` option.
 */
export class QoderSessionImport implements HarnessSessionImportCapability {
  readonly #dependencies: QoderSessionImportDependencies;
  readonly #scope: SessionImportScope;

  constructor(dependencies: QoderSessionImportDependencies) {
    this.#dependencies = dependencies;
    const name = dependencies.displayName;
    this.#scope = new SessionImportScope({
      closedMessage: `${name} Session import is closed`,
      unavailableMessage: `${name} sessions could not be read; check storage access and retry`,
      notFoundMessage: `${name} Session is no longer importable`,
    });
  }

  listCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> {
    return this.#scope.read(async (signal) => {
      const candidates = new Map<string, HarnessSessionImportCandidate>();
      for (const info of await this.#dependencies.listSessions()) {
        signal.throwIfAborted();
        const candidate = await this.#candidate(info);
        // The SDK lists most recent first; a repeated identity keeps its first, newest entry.
        if (candidate && !candidates.has(candidate.nativeSessionId))
          candidates.set(candidate.nativeSessionId, candidate);
      }
      return [...candidates.values()];
    });
  }

  resolveCandidate(nativeSessionId: string): Promise<HarnessResult<HarnessSessionImportSource>> {
    return this.#scope.resolve(async (signal) => {
      const info = await this.#dependencies.getSessionInfo(nativeSessionId);
      signal.throwIfAborted();
      if (info?.sessionId !== nativeSessionId) return null;
      const candidate = await this.#candidate(info);
      if (!candidate) return null;
      return {
        candidate,
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: this.#dependencies.harnessId,
          nativeSessionId,
          formatVersion: 1,
        }),
      };
    });
  }

  close(): Promise<void> {
    return this.#scope.close();
  }

  async #candidate(info: SDKSessionInfo): Promise<HarnessSessionImportCandidate | null> {
    // A transcript without a recorded directory cannot be resumed in its project.
    if (typeof info.cwd !== "string" || !path.isAbsolute(info.cwd)) return null;
    // Kept as Qoder recorded it; resume looks the transcript up from this directory.
    const cwd = path.resolve(info.cwd);
    try {
      if (!(await stat(cwd)).isDirectory()) return null;
    } catch (error) {
      if (isStorageAccessError(error)) throw error;
      return null;
    }
    return sessionImportCandidate({
      nativeSessionId: info.sessionId,
      cwd,
      title:
        sessionImportTitle(info.customTitle) ??
        sessionImportTitle(info.summary) ??
        sessionImportTitle(info.firstPrompt),
      updatedAt: info.lastModified,
      // The SDK exposes no cross-process activity marker: idleness cannot be established.
    });
  }
}

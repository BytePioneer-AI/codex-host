import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonRpcRequest, JsonValue } from "@codexhost/protocol-core";
import {
  RELEASE_ANNOUNCEMENT_GET_METHOD,
  jsonValueSchema,
  releaseAnnouncementAcknowledgeParamsSchema,
  releaseAnnouncementGetParamsSchema,
  type ReleaseAnnouncement,
  type ReleaseAnnouncementGetResult,
} from "@codexhost/shared-contracts";
import { fetchGitHubReleaseAnnouncement, readRuntimeMetadata } from "@codexhost/update-manager";

import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import { codexhostDataDirectory } from "./external-clients.js";

const NO_ANNOUNCEMENT = { announcement: null, unread: false } as const;

/** One instance per Host process, shared by its Desktop sessions and Web client channel. */
export class HostReleaseAnnouncement {
  readonly #version: Promise<string | null>;
  readonly #directory: string;
  readonly #file: string;
  #announcement: ReleaseAnnouncement | undefined;
  #pending: Promise<ReleaseAnnouncement | null> | undefined;

  constructor(runtimePath: string, environment: NodeJS.ProcessEnv) {
    this.#version = readRuntimeMetadata(runtimePath, environment).then(
      ({ version }) => version,
      () => null,
    );
    this.#directory = codexhostDataDirectory(environment);
    this.#file = join(this.#directory, "release-announcement-v1.json");
  }

  async #isAcknowledged(version: string): Promise<boolean> {
    try {
      const state: unknown = JSON.parse(await readFile(this.#file, "utf8"));
      return (
        typeof state === "object" &&
        state !== null &&
        "acknowledgedVersion" in state &&
        state.acknowledgedVersion === version
      );
    } catch {
      return false;
    }
  }

  async #read(version: string): Promise<ReleaseAnnouncement | null> {
    if (this.#announcement) return this.#announcement;
    this.#pending ??= fetchGitHubReleaseAnnouncement(version)
      .then((announcement) => {
        if (announcement) this.#announcement = announcement;
        return announcement;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }

  async get(manual: boolean): Promise<ReleaseAnnouncementGetResult> {
    const version = await this.#version;
    if (!version || (!manual && (await this.#isAcknowledged(version)))) return NO_ANNOUNCEMENT;
    const announcement = await this.#read(version);
    if (!announcement) return NO_ANNOUNCEMENT;
    // An acknowledgement may have landed while GitHub was responding.
    const unread = !(await this.#isAcknowledged(version));
    return manual || unread ? { announcement, unread } : NO_ANNOUNCEMENT;
  }

  async acknowledge(version: string): Promise<boolean> {
    if (version !== (await this.#version)) return false;
    if (await this.#isAcknowledged(version)) return true;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ acknowledgedVersion: version }) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
    return true;
  }
}

export async function handleReleaseAnnouncementRequest(
  host: HostReleaseAnnouncement | undefined,
  request: JsonRpcRequest,
): Promise<JsonValue> {
  if (request.method === RELEASE_ANNOUNCEMENT_GET_METHOD) {
    const params = releaseAnnouncementGetParamsSchema.safeParse(
      request.params === undefined ? {} : request.params,
    );
    if (!params.success) return rpcError(request, -32602, "Invalid release announcement query");
    const result = (await host?.get(params.data.manual === true)) ?? NO_ANNOUNCEMENT;
    return rpcEnvelope(request, { result: jsonValueSchema.parse(result) });
  }
  const params = releaseAnnouncementAcknowledgeParamsSchema.safeParse(request.params);
  if (!params.success)
    return rpcError(request, -32602, "Invalid release announcement acknowledgement");
  if (!host) return rpcError(request, -32090, "Release announcements are unavailable");
  try {
    if (!(await host.acknowledge(params.data.version)))
      return rpcError(request, -32602, "Only the running version can be acknowledged");
    return rpcEnvelope(request, { result: { acknowledged: true } });
  } catch {
    return rpcError(request, -32000, "Could not save release announcement acknowledgement");
  }
}

import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { harnessSessionImportCandidateSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  listHermesSessionCandidates,
  resolveHermesSessionCandidate,
} from "../src/hermes-import.js";

function connection(response: unknown): ClientSideConnection {
  return { request: () => Promise.resolve(response) } as unknown as ClientSideConnection;
}

const valid = { sessionId: "ok", title: "Title", updatedAt: "2026-01-02T03:04:05.000Z", cwd: "/w" };

describe("Hermes Session import candidates", () => {
  it("skips rows that violate the shared contract instead of poisoning the list", async () => {
    const candidates = await listHermesSessionCandidates({
      connection: connection({
        sessions: [
          valid,
          { sessionId: "fractional", updatedAt: 1_700_000_000_000.5, cwd: "/w", running: false },
          { sessionId: "bad-time", updatedAt: "not a date", cwd: "/w" },
          { sessionId: "negative-time", updatedAt: -1, cwd: "/w" },
          { sessionId: "no-cwd", updatedAt: 1 },
          { sessionId: "messy-title", title: " a\0b\nc ", updatedAt: 1, cwd: "/w" },
          { sessionId: "nul-cwd", updatedAt: 1, cwd: "/w\0" },
          { sessionId: " ", updatedAt: 1, cwd: "/w" },
          { sessionId: 7, updatedAt: 1, cwd: "/w" },
          null,
          "row",
        ],
      }),
    });

    expect(candidates).toEqual([
      {
        nativeSessionId: "ok",
        title: "Title",
        updatedAt: Date.parse(valid.updatedAt),
        cwd: "/w",
        running: null,
      },
      {
        nativeSessionId: "fractional",
        title: null,
        updatedAt: 1_700_000_000_000,
        cwd: "/w",
        running: false,
      },
      // A fixable title must not cost the user the whole Session.
      { nativeSessionId: "messy-title", title: "ab c", updatedAt: 1, cwd: "/w", running: null },
    ]);
    // The Host validates the whole array with this schema; every survivor must pass it.
    expect(harnessSessionImportCandidateSchema.array().safeParse(candidates).success).toBe(true);
  });

  it.each([null, "text", {}, { sessions: null }, { sessions: "none" }])(
    "treats malformed response %j as no candidates",
    async (response) => {
      expect(await listHermesSessionCandidates({ connection: connection(response) })).toEqual([]);
    },
  );

  it("resolves only a still-valid selected Session", async () => {
    const response = {
      sessions: [null, valid, { sessionId: "broken", updatedAt: "not a date", cwd: "/w" }],
    };
    expect(
      await resolveHermesSessionCandidate({
        connection: connection(response),
        nativeSessionId: "ok",
      }),
    ).toMatchObject({
      candidate: { nativeSessionId: "ok", cwd: "/w" },
      nativeRef: { harnessId: "hermes", nativeSessionId: "ok" },
    });
    for (const nativeSessionId of ["broken", "missing"]) {
      expect(
        await resolveHermesSessionCandidate({ connection: connection(response), nativeSessionId }),
      ).toBeNull();
    }
  });
});

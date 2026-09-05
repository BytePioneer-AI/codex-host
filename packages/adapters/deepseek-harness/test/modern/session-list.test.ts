import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX,
} from "@codexhost/shared-contracts";

import {
  loadModernSessionCandidates,
  ModernSessionListError,
  parseModernSessionCandidates,
  type ModernSessionListRemote,
} from "../../src/modern/session-list.js";
import {
  ModernRemoteConnectionError,
  type ModernRemoteConnectionErrorCode,
} from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

const cwd = path.resolve("fixture-modern-session-list");

function row(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    running: false,
    blank: false,
    cwd,
    ...overrides,
  };
}

class FakeRemote implements ModernSessionListRemote {
  readonly calls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }> = [];

  constructor(
    readonly result: ModernRemoteResult<unknown> | Error = {
      ok: true,
      value: { items: [] },
    },
  ) {}

  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ModernRemoteResult<T>> {
    this.calls.push({ endpoint, args, ...(signal ? { signal } : {}) });
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result as ModernRemoteResult<T>);
  }
}

describe("DeepSeek Harness Modern Session list", () => {
  it("projects eligible roots and ordinary Forks in authoritative order", () => {
    const nonCanonicalCwd = `${cwd}${path.sep}child${path.sep}..`;
    const missingCwd = row({ sessionId: "missing-cwd" });
    delete missingCwd.cwd;
    const candidates = parseModernSessionCandidates({
      items: [
        row({
          sessionId: "titled",
          updatedAt: 50,
          projections: {
            asOfSeq: 3,
            values: { title: "Native title", unknownProjection: { retainedByDsh: true } },
          },
        }),
        row({
          sessionId: "fork-running",
          updatedAt: 40,
          running: true,
          parentSessionId: "parent",
        }),
        row({
          sessionId: "invalid-title",
          updatedAt: 30,
          projections: { asOfSeq: -1, values: { title: { text: "not a title" } } },
        }),
        row({ sessionId: "subagent", origin: "subagent" }),
        row({ sessionId: "blank", blank: true }),
        missingCwd,
        row({ sessionId: "relative-cwd", cwd: "relative/workspace" }),
        row({ sessionId: "noncanonical-cwd", cwd: nonCanonicalCwd }),
        row({ sessionId: "nul-cwd", cwd: `${cwd}\0ignored` }),
      ],
    });

    expect(candidates).toEqual([
      {
        nativeSessionId: "titled",
        title: "Native title",
        updatedAt: 50,
        cwd,
        running: false,
      },
      {
        nativeSessionId: "fork-running",
        title: null,
        updatedAt: 40,
        cwd,
        running: true,
      },
      {
        nativeSessionId: "invalid-title",
        title: null,
        updatedAt: 30,
        cwd,
        running: false,
      },
    ]);
  });

  it.each([
    ["non-object root", []],
    ["extra root key", { items: [], extra: true }],
    ["missing required row key", { items: [{ sessionId: "missing", updatedAt: 1 }] }],
    ["extra row key", { items: [row({ extra: true })] }],
    ["invalid running", { items: [row({ running: 1 })] }],
    ["invalid origin", { items: [row({ origin: "user" })] }],
    ["invalid parent identity", { items: [row({ parentSessionId: " " })] }],
    ["invalid projections", { items: [row({ projections: { asOfSeq: 0 } })] }],
    ["invalid projection cursor", { items: [row({ projections: { asOfSeq: -2, values: {} } })] }],
    ["empty identity", { items: [row({ sessionId: " " })] }],
    ["NUL identity", { items: [row({ sessionId: "session\0suffix" })] }],
    ["negative time", { items: [row({ updatedAt: -1 })] }],
    ["fractional time", { items: [row({ updatedAt: 1.5 })] }],
    [
      "unrepresentable time",
      { items: [row({ updatedAt: DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX + 1 })] },
    ],
    ["duplicate identity", { items: [row(), row()] }],
  ])("rejects %s without returning a partial list", (_label, value) => {
    expect(() => parseModernSessionCandidates(value)).toThrowError(
      expect.objectContaining({ code: "protocolError" }),
    );
  });

  it("enforces item and identity/cwd field bounds", () => {
    expect(() =>
      parseModernSessionCandidates({
        items: Array.from({ length: DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH + 1 }, (_, index) =>
          row({ sessionId: `session-${index}` }),
        ),
      }),
    ).toThrowError(expect.objectContaining({ code: "limitExceeded" }));
    expect(() =>
      parseModernSessionCandidates({
        items: [row({ sessionId: "s".repeat(DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH + 1) })],
      }),
    ).toThrowError(expect.objectContaining({ code: "protocolError" }));
    expect(() =>
      parseModernSessionCandidates({
        items: [row({ cwd: `C:${"x".repeat(DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH)}` })],
      }),
    ).toThrowError(expect.objectContaining({ code: "limitExceeded" }));
  });

  it("keeps an exact-bound title and degrades an oversized title to null", () => {
    const exact = "t".repeat(DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH);
    expect(
      parseModernSessionCandidates({
        items: [
          row({
            sessionId: "exact-title",
            projections: { asOfSeq: 0, values: { title: exact } },
          }),
          row({
            sessionId: "oversized-title",
            projections: { asOfSeq: 0, values: { title: `${exact}x` } },
          }),
        ],
      }).map(({ title }) => title),
    ).toEqual([exact, null]);
  });

  it("rejects cyclic and over-deep projection values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      parseModernSessionCandidates({
        items: [row({ projections: { asOfSeq: 0, values: cyclic } })],
      }),
    ).toThrowError(expect.objectContaining({ code: "protocolError" }));

    const deep: Record<string, unknown> = {};
    let current = deep;
    for (let index = 0; index < 65; index += 1) {
      const child: Record<string, unknown> = {};
      current.child = child;
      current = child;
    }
    expect(() =>
      parseModernSessionCandidates({
        items: [row({ projections: { asOfSeq: 0, values: deep } })],
      }),
    ).toThrowError(expect.objectContaining({ code: "limitExceeded" }));
  });

  it("accepts the exact JSON node work bound and rejects one additional node", () => {
    // root + items + row + five scalar fields + projections/asOfSeq/values/array = 12 nodes.
    const exactProjectionNodes = Array(199_988).fill(null);
    expect(
      parseModernSessionCandidates({
        items: [row({ projections: { asOfSeq: 0, values: { nodes: exactProjectionNodes } } })],
      }),
    ).toHaveLength(1);
    expect(() =>
      parseModernSessionCandidates({
        items: [
          row({
            projections: { asOfSeq: 0, values: { nodes: [...exactProjectionNodes, null] } },
          }),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "limitExceeded" }));
  });

  it("calls exact session/list args and forwards the caller lifetime", async () => {
    const remote = new FakeRemote({ ok: true, value: { items: [row()] } });
    const lifetime = new AbortController();

    await expect(loadModernSessionCandidates(remote, lifetime.signal)).resolves.toHaveLength(1);
    expect(remote.calls).toEqual([
      { endpoint: "session/list", args: { _request: {} }, signal: lifetime.signal },
    ]);
  });

  it.each([
    ["protocolError", "protocolError"],
    ["authenticationRequired", "authenticationRequired"],
    ["processExited", "processExited"],
    ["notInstalled", "notInstalled"],
    ["cancelled", "cancelled"],
    ["unavailable", "unavailable"],
  ] as const satisfies readonly (readonly [
    ModernRemoteConnectionErrorCode,
    ModernSessionListError["code"],
  ])[])("preserves connection error %s as %s", async (sourceCode, expectedCode) => {
    const canary = "SESSION_LIST_CONNECTION_SECRET_CANARY";
    const source = new ModernRemoteConnectionError(
      sourceCode,
      `secret=${canary}`,
      `api_key=${canary}`,
    );
    Object.defineProperty(source, "cause", { enumerable: true, value: new Error(canary) });

    const failure = await loadModernSessionCandidates(new FakeRemote(source)).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: expectedCode,
      nativeCode: "api_key=[redacted]",
    });
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(canary);
  });

  it("sanitizes Remote failure details", async () => {
    const canary = "SESSION_LIST_REMOTE_SECRET_CANARY";
    const failure = await loadModernSessionCandidates(
      new FakeRemote({
        ok: false,
        error: {
          code: `api_key=${canary}`,
          message: `secret=${canary}`,
          details: { token: canary },
        },
      }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModernSessionListError);
    expect(failure).toMatchObject({ code: "remoteError", nativeCode: "api_key=[redacted]" });
    expect(JSON.stringify(failure)).not.toContain(canary);
  });
});

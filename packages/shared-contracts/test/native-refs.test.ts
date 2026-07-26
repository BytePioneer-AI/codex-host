import { describe, expect, it } from "vitest";

import {
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "../src/index.js";
import type { NativeCheckpointRef, NativeTurnRef } from "../src/index.js";

function assertNativeRefIsolation(
  turnRef: NativeTurnRef,
  checkpointRef: NativeCheckpointRef,
): void {
  // @ts-expect-error Stable Turn identity is not a fork Checkpoint.
  const invalidCheckpoint: NativeCheckpointRef = turnRef;
  // @ts-expect-error A fork Checkpoint is not stable Turn identity.
  const invalidTurn: NativeTurnRef = checkpointRef;

  void invalidCheckpoint;
  void invalidTurn;
}

void assertNativeRefIsolation;

const sessionRef = {
  harnessId: "pi",
  nativeSessionId: "synthetic-session",
  locator: { storage: "adapter-managed", partition: 2 },
  formatVersion: 1,
} as const;
const turnRef = {
  harnessId: "pi",
  nativeSessionId: "synthetic-session",
  nativeTurnKey: "synthetic-turn",
  formatVersion: 1,
} as const;
const checkpointRef = {
  harnessId: "pi",
  nativeSessionId: "synthetic-session",
  checkpointId: "synthetic-checkpoint",
  locator: ["adapter-managed", 3],
  formatVersion: 1,
} as const;

describe("opaque native reference contracts", () => {
  it("accepts and preserves all V1 reference kinds", () => {
    expect(nativeSessionRefSchema.parse(sessionRef)).toEqual(sessionRef);
    expect(nativeTurnRefSchema.parse(turnRef)).toEqual(turnRef);
    expect(nativeCheckpointRefSchema.parse(checkpointRef)).toEqual(checkpointRef);
  });

  it("returns a validation failure for a circular locator", () => {
    const locator: Record<string, unknown> = {};
    locator.self = locator;

    expect(nativeSessionRefSchema.safeParse({ ...sessionRef, locator }).success).toBe(false);
  });

  it.each([
    [nativeSessionRefSchema, { ...sessionRef, formatVersion: 2 }],
    [nativeSessionRefSchema, { ...sessionRef, nativeSessionId: "   " }],
    [nativeSessionRefSchema, { ...sessionRef, extra: true }],
    [nativeSessionRefSchema, { ...sessionRef, locator: { invalid: undefined } }],
    [nativeTurnRefSchema, { ...turnRef, nativeTurnKey: "\t" }],
    [nativeTurnRefSchema, { ...turnRef, locator: {} }],
    [nativeCheckpointRefSchema, { ...checkpointRef, checkpointId: "" }],
    [nativeCheckpointRefSchema, { ...checkpointRef, locator: 1n }],
  ])("rejects invalid or extended V1 reference %#", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("uses only synthetic, non-sensitive reference examples", () => {
    const serialized = JSON.stringify([sessionRef, turnRef, checkpointRef]);

    expect(serialized).not.toMatch(
      /transcript|prompt|tool.?output|diff|access.?token|api.?key|oauth|[A-Z]:\\|\/Users\//iu,
    );
  });
});

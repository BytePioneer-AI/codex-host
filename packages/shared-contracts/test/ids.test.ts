import { describe, expect, it } from "vitest";

import {
  harnessIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
} from "../src/index.js";
import type {
  HarnessId,
  HostInteractionId,
  HostItemId,
  HostThreadId,
  HostTurnId,
} from "../src/index.js";

function assertBrandIsolation(
  harnessId: HarnessId,
  threadId: HostThreadId,
  turnId: HostTurnId,
  itemId: HostItemId,
  interactionId: HostInteractionId,
): void {
  void harnessId;
  void threadId;

  // @ts-expect-error Host Turn IDs are not Host Thread IDs.
  const invalidThreadId: HostThreadId = turnId;
  // @ts-expect-error Host Turn IDs are not Host Item IDs.
  const invalidItemId: HostItemId = turnId;
  // @ts-expect-error Host Turn IDs are not Host Interaction IDs.
  const invalidInteractionId: HostInteractionId = turnId;
  // @ts-expect-error Harness IDs are not Host Thread IDs.
  const invalidHarnessAssignment: HostThreadId = harnessId;

  void invalidThreadId;
  void invalidItemId;
  void invalidInteractionId;
  void invalidHarnessAssignment;
  void itemId;
  void interactionId;
}

void assertBrandIsolation;

describe("opaque identifier contracts", () => {
  const schemas = [
    harnessIdSchema,
    hostThreadIdSchema,
    hostTurnIdSchema,
    hostItemIdSchema,
    hostInteractionIdSchema,
  ] as const;

  it("preserves opaque identifiers without assuming an encoding", () => {
    const opaqueValue = "  Mixed Case/id:value  ";

    for (const schema of schemas) {
      expect(schema.parse(opaqueValue)).toBe(opaqueValue);
    }
  });

  it.each(["", " ", "\t\r\n"])("rejects blank identifier %j", (value) => {
    for (const schema of schemas) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});

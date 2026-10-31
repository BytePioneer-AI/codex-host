import { expect, it, vi } from "vitest";
import {
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
  method,
} from "./app-server-host-fixture.js";

it("persists confirmed native admission before completion and preserves that Host Turn at termination", async () => {
  const fixture = createFixture();
  try {
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session?.initialState.nativeRef) throw new Error("Missing native Session");
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: session.initialState.nativeRef.nativeSessionId,
      nativeTurnKey: "fake-turn-1",
      formatVersion: 1,
    });
    session.emitEvent({
      type: "turn.identity.confirmed",
      turnId: hostTurnIdSchema.parse(turnId),
      nativeTurnRef,
    });
    await vi.waitFor(async () =>
      expect(
        await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
      ).toMatchObject({ turnMappings: [{ hostTurnId: turnId, nativeTurnRef }] }),
    );
    expect(fixture.collector.messages.some((message) => method(message, "turn/completed"))).toBe(
      false,
    );
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    const record = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    expect(record?.turnMappings).toHaveLength(1);
    expect(record?.turnMappings[0]).toMatchObject({ hostTurnId: turnId, nativeTurnRef });
  } finally {
    await stopFixture(fixture);
  }
});

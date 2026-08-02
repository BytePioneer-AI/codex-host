import { describe, expect, it } from "vitest";
import { harnessIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import type { HarnessError, HarnessOutput, HostEvent } from "../src/index.js";
import { FakeHarnessSession } from "../src/testing.js";

const turnId = (value: string) => hostTurnIdSchema.parse(value);
const textTurn = (value: string) => ({
  type: "turn.start" as const,
  turnId: turnId(value),
  input: [{ type: "text" as const, text: value }],
});
const failure: HarnessError = {
  code: "nativeFailure",
  message: "synthetic failure",
  retryable: false,
};

async function collect(outputs: AsyncIterable<HarnessOutput>): Promise<HarnessOutput[]> {
  const collected: HarnessOutput[] = [];
  for await (const output of outputs) collected.push(output);
  return collected;
}

function events(outputs: HarnessOutput[]): HostEvent[] {
  return outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
}

describe("Host Approval interaction contract", () => {
  it("emits an early bounded Approval and accepts independent Allow and Deny responses", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("approval"));
    const allowId = session.requestApproval("Run native action", "Needs one-shot permission");
    const denyId = session.requestApproval("Run another native action");

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: denyId,
        response: { type: "approval", actionId: "deny" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowId,
        response: { type: "approval", actionId: "allowOnce" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    session.succeedTurn();
    await session.close();

    const outputs = await collected;
    const approvals = outputs.flatMap((output) =>
      output.kind === "interaction" && output.interaction.type === "approval"
        ? [output.interaction]
        : [],
    );
    expect(approvals).toEqual([
      expect.objectContaining({
        interactionId: allowId,
        turnId: "approval",
        title: "Run native action",
        description: "Needs one-shot permission",
        subject: { type: "nativeAction" },
        actions: [
          { id: "allowOnce", label: "Allow once", effect: "allowOnce" },
          { id: "deny", label: "Deny", effect: "deny" },
        ],
      }),
      expect.objectContaining({ interactionId: denyId, type: "approval" }),
    ]);
    expect(events(outputs).filter((event) => event.type === "interaction.closed")).toEqual([
      expect.objectContaining({ interactionId: denyId, reason: "responded" }),
      expect.objectContaining({ interactionId: allowId, reason: "responded" }),
    ]);
    expect(session.interactionResponses.map(({ response }) => response)).toEqual([
      { type: "approval", actionId: "deny" },
      { type: "approval", actionId: "allowOnce" },
    ]);
  });

  it("accepts only declared Session and always scope actions", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake-scopes"));
    const collected = collect(session.outputs);
    await session.execute(textTurn("scopes"));
    const sessionId = session.requestApproval("Session action", undefined, "session");
    const alwaysId = session.requestApproval("Persistent action", undefined, "always");

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: sessionId,
        response: { type: "approval", actionId: "allowForSession" },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: alwaysId,
        response: { type: "approval", actionId: "allowAlways" },
      }),
    ).resolves.toMatchObject({ ok: true });
    session.succeedTurn();
    await session.close();

    const approvals = (await collected).flatMap((output) =>
      output.kind === "interaction" && output.interaction.type === "approval"
        ? [output.interaction]
        : [],
    );
    expect(approvals[0]?.actions).toContainEqual({
      id: "allowForSession",
      label: "Allow this conversation",
      effect: "allowForSession",
    });
    expect(approvals[1]?.actions).toContainEqual({
      id: "allowAlways",
      label: "Always allow",
      effect: "allowAlways",
    });
  });

  it("rejects wrong-type, undeclared, duplicate, and wrong-Session responses", async () => {
    const owner = new FakeHarnessSession(harnessIdSchema.parse("fake-owner"));
    const other = new FakeHarnessSession(harnessIdSchema.parse("fake-other"));
    const ownerCollected = collect(owner.outputs);
    const otherCollected = collect(other.outputs);
    await owner.execute(textTurn("owner"));
    await other.execute(textTurn("other"));
    const interactionId = owner.requestApproval("Approve");

    await expect(
      owner.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      owner.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "approval", actionId: "allowForSession" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      other.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "approval", actionId: "deny" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await expect(
      owner.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "approval", actionId: "deny" },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      owner.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "approval", actionId: "deny" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });

    owner.succeedTurn();
    other.succeedTurn();
    await owner.close();
    await other.close();
    await Promise.all([ownerCollected, otherCollected]);
  });

  it("closes pending Approvals once before cancel, fault, and Session-close terminals", async () => {
    const cancelled = new FakeHarnessSession(harnessIdSchema.parse("fake-cancel"));
    const cancelledCollected = collect(cancelled.outputs);
    await cancelled.execute(textTurn("cancel"));
    const cancelledId = cancelled.requestApproval("Cancel pending");
    await cancelled.execute({ type: "turn.cancel", turnId: turnId("cancel") });
    cancelled.completeCancellation();
    await cancelled.close();

    const cancelledEvents = events(await cancelledCollected);
    const cancelledCloses = cancelledEvents.filter(
      (event) => event.type === "interaction.closed" && event.interactionId === cancelledId,
    );
    expect(cancelledCloses).toEqual([expect.objectContaining({ reason: "cancelled" })]);
    const cancelledCloseIndex = cancelledEvents.findIndex(
      (event) => event.type === "interaction.closed" && event.interactionId === cancelledId,
    );
    expect(cancelledCloseIndex).toBeGreaterThanOrEqual(0);
    expect(cancelledCloseIndex).toBeLessThan(
      cancelledEvents.findIndex((event) => event.type === "turn.completed"),
    );

    const faulted = new FakeHarnessSession(harnessIdSchema.parse("fake-fault"));
    const faultedCollected = collect(faulted.outputs);
    await faulted.execute(textTurn("fault"));
    const faultedId = faulted.requestApproval("Fault pending");
    faulted.fault(failure);
    const faultedEvents = events(await faultedCollected);
    expect(
      faultedEvents.findIndex(
        (event) => event.type === "interaction.closed" && event.interactionId === faultedId,
      ),
    ).toBeLessThan(faultedEvents.findIndex((event) => event.type === "turn.completed"));

    const closed = new FakeHarnessSession(harnessIdSchema.parse("fake-close"));
    const closedCollected = collect(closed.outputs);
    await closed.execute(textTurn("close"));
    const closedId = closed.requestApproval("Close pending");
    await closed.close();
    const closedEvents = events(await closedCollected);
    expect(
      closedEvents.findIndex(
        (event) => event.type === "interaction.closed" && event.interactionId === closedId,
      ),
    ).toBeLessThan(closedEvents.findIndex((event) => event.type === "turn.completed"));
  });
});

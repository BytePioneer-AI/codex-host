import { describe, expect, it } from "vitest";
import { harnessKnownTurnSchema, harnessTurnRecoverySchema } from "@codexhost/shared-contracts";
import { brokerOpenInputSchema, harnessOutputSchema } from "../src/validation.js";

const nativeTurnRef = {
  harnessId: "sample-agent",
  nativeSessionId: "native-session",
  nativeTurnKey: "native-user",
  formatVersion: 1,
};
const known = { turnId: "original-host-turn", nativeTurnRef };
describe("generic active Turn recovery wire data", () => {
  it("preserves Host/native mappings and accepts early identity without calling it completion", () => {
    expect(harnessKnownTurnSchema.parse(known)).toEqual(known);
    const input = {
      kind: "resume",
      cwd: "/workspace",
      nativeRef: { harnessId: "sample-agent", nativeSessionId: "native-session", formatVersion: 1 },
      knownTurns: [known],
    };
    expect(brokerOpenInputSchema.parse(input)).toEqual(input);
    const output = { kind: "event", event: { type: "turn.identity.confirmed", ...known } };
    expect(harnessOutputSchema.parse(output)).toEqual(output);
    expect(
      harnessOutputSchema.safeParse({
        kind: "event",
        event: { ...output.event, nativeTurnRef: { ...nativeTurnRef, nativeTurnKey: "" } },
      }).success,
    ).toBe(false);
    expect(
      harnessOutputSchema.safeParse({
        kind: "event",
        event: { ...output.event, outcome: { status: "succeeded" } },
      }).success,
    ).toBe(false);
  });
  it("validates recovery data and rejects extra control fields", () => {
    expect(
      harnessTurnRecoverySchema.parse({
        ...known,
        input: [{ type: "text", text: "original input" }],
      }),
    ).toMatchObject(known);
    expect(harnessTurnRecoverySchema.safeParse({ ...known, input: [], resend: true }).success).toBe(
      false,
    );
    expect(
      brokerOpenInputSchema.safeParse({
        kind: "resume",
        cwd: "/workspace",
        nativeRef: {
          harnessId: "sample-agent",
          nativeSessionId: "native-session",
          formatVersion: 1,
        },
        knownTurns: [{ ...known, turnId: "" }],
      }).success,
    ).toBe(false);
  });
});

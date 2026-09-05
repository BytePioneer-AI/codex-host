import { describe, expect, it } from "vitest";

import { OpenCodeMessageIdGenerator, parseOpenCodeMessageGroup } from "../src/message-grouping.js";

describe("OpenCode Host Turn message grouping", () => {
  it("generates ascending native IDs with a recoverable group and sequence", () => {
    const generator = new OpenCodeMessageIdGenerator();
    const group = generator.createGroup("turn-1");
    const ids = [
      generator.next(group, 1_000),
      generator.next(group, 1_000),
      generator.next(group, 999),
    ];

    expect(ids).toEqual([...ids].sort());
    expect(ids.map((id) => id.slice(4, 16))).toEqual([
      "0000003e8001",
      "0000003e8002",
      "0000003e8003",
    ]);
    expect(ids.every((id) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(id))).toBe(true);
    expect(ids.map(parseOpenCodeMessageGroup)).toEqual([
      { token: expect.stringMatching(/^[0-9A-Za-z]{10}$/u), sequence: 0, kind: "input" },
      { token: expect.stringMatching(/^[0-9A-Za-z]{10}$/u), sequence: 1, kind: "input" },
      { token: expect.stringMatching(/^[0-9A-Za-z]{10}$/u), sequence: 2, kind: "input" },
    ]);
    expect(new Set(ids.map((id) => parseOpenCodeMessageGroup(id)?.token)).size).toBe(1);
  });

  it("marks a recovery message without changing its native sort shape", () => {
    const generator = new OpenCodeMessageIdGenerator();
    const group = generator.createGroup("turn-with-recovery");
    const root = generator.next(group, 1_000);
    const recovery = generator.nextRecovery(group, 1_001);

    expect(recovery).toMatch(/^msg_[0-9a-f]{12}CR[0-9A-Za-z]{12}$/u);
    expect(root < recovery).toBe(true);
    expect(parseOpenCodeMessageGroup(recovery)).toEqual({
      token: parseOpenCodeMessageGroup(root)?.token,
      sequence: 1,
      kind: "recovery",
    });
  });

  it("reserves the final sequence value for orphan recovery", () => {
    const generator = new OpenCodeMessageIdGenerator();
    const group = generator.createGroup("recovery-capacity");
    let lastInput = "";
    for (let sequence = 0; sequence < 3_843; sequence += 1) {
      lastInput = generator.next(group, 1_000 + sequence);
    }
    expect(parseOpenCodeMessageGroup(lastInput)?.sequence).toBe(3_842);
    expect(() => generator.next(group, 5_000)).toThrow("too many steering inputs");

    const recovery = generator.nextRecovery(group, 5_001);
    expect(parseOpenCodeMessageGroup(recovery)).toMatchObject({
      sequence: 3_843,
      kind: "recovery",
    });
  });

  it("advances a virtual millisecond before the native 12-bit counter can wrap", () => {
    const generator = new OpenCodeMessageIdGenerator();
    const ids = Array.from({ length: 4_096 }, (_, index) =>
      generator.next(generator.createGroup(`counter-boundary-${index}`), 2_000),
    );

    expect(ids.at(-2)?.slice(4, 16)).toBe("0000007d0fff");
    expect(ids.at(-1)?.slice(4, 16)).toBe("0000007d1001");
    expect(ids).toEqual([...ids].sort());
  });

  it("does not interpret ordinary or malformed native IDs as Host groups", () => {
    expect(parseOpenCodeMessageGroup("msg_native_1")).toBeNull();
    expect(parseOpenCodeMessageGroup("msg_000000000001CHshort00")).toBeNull();
    expect(parseOpenCodeMessageGroup("msg_000000000001CH0123456789!!")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { resolveHandoffPoint } from "../src/client/handoff.ts";

describe("resolveHandoffPoint", () => {
  it("distinguishes running turns from stopped or unloaded sessions before any Turn finishes", () => {
    expect(resolveHandoffPoint(undefined, undefined)).toEqual({ status: "unavailable" });
    expect(
      resolveHandoffPoint(
        { openState: "loading", running: false },
        { hasMore: false, entries: [] },
      ),
    ).toEqual({
      status: "unavailable",
    });
    expect(
      resolveHandoffPoint({ openState: "loading", running: true }, { hasMore: false, entries: [] }),
    ).toEqual({
      status: "pending",
    });
    expect(
      resolveHandoffPoint(
        { openState: "open", running: true },
        { hasMore: false, entries: [{ event: { type: "turn/start", seq: 1 } }] },
      ),
    ).toEqual({ status: "pending" });
    expect(
      resolveHandoffPoint({ openState: "open", running: false }, { hasMore: false, entries: [] }),
    ).toEqual({ status: "unavailable" });
    expect(
      resolveHandoffPoint(
        { openState: "open", running: false },
        { hasMore: false, entries: [{ event: { type: "turn/start", seq: 1 } }] },
      ),
    ).toEqual({ status: "unavailable" });
  });

  it("is ready without an explicit cut when the latest ended Turn completed", () => {
    expect(
      resolveHandoffPoint(
        { openState: "open", running: true },
        {
          hasMore: false,
          entries: [
            { event: { type: "turn/start", seq: 1 } },
            { event: { type: "turn/end", seq: 4, data: { reason: { kind: "completed" } } } },
            { event: { type: "turn/start", seq: 5 } },
          ],
        },
      ),
    ).toEqual({ status: "ready" });
  });

  it("falls back to the last completed Turn seq when the latest Turn ended with an error or abort", () => {
    expect(
      resolveHandoffPoint(
        { openState: "open", running: false },
        {
          hasMore: false,
          entries: [
            { event: { type: "turn/end", seq: 10, data: { reason: { kind: "completed" } } } },
            { event: { type: "turn/end", seq: 20, data: { reason: { kind: "error" } } } },
          ],
        },
      ),
    ).toEqual({ status: "ready", atSeq: 10 });

    expect(
      resolveHandoffPoint(
        { openState: "open", running: false },
        {
          hasMore: false,
          entries: [
            { event: { type: "turn/end", seq: 20, data: { reason: { kind: "aborted" } } } },
          ],
        },
      ),
    ).toEqual({ status: "unavailable" });

    expect(
      resolveHandoffPoint(
        { openState: "open", running: false },
        {
          hasMore: false,
          entries: [{ event: { type: "turn/end", seq: 20, data: { reason: { kind: "error" } } } }],
        },
      ),
    ).toEqual({ status: "unavailable" });

    expect(
      resolveHandoffPoint(
        { openState: "open", running: true },
        {
          hasMore: false,
          entries: [
            { event: { type: "turn/end", seq: 20, data: { reason: { kind: "error" } } } },
            { event: { type: "turn/start", seq: 21 } },
          ],
        },
      ),
    ).toEqual({ status: "pending" });
  });

  it("remains ready when older pages exist outside the loaded window", () => {
    expect(
      resolveHandoffPoint(
        { openState: "open", running: false },
        {
          hasMore: true,
          entries: [{ event: { type: "turn/end", seq: 20, data: { reason: { kind: "error" } } } }],
        },
      ),
    ).toEqual({ status: "ready" });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { InputTriggerController } from "@deepseek-ai/dsh-client-ui-input-trigger/src/client/controller.ts";
import { sourceMatchesTrigger } from "@deepseek-ai/dsh-client-ui-input-trigger/src/core/source.ts";
import type { InputTriggerSource } from "@deepseek-ai/dsh-client-ui-input-trigger/client";

function fixture() {
  const bail = vi.fn(() => true);
  let invalidate: (() => void) | undefined;
  const commands: InputTriggerSource = {
    trigger: "/",
    name: "command",
    order: 0,
    candidates: vi.fn(async (_, req) => ("file".includes(req.query) ? [{ name: "file" }] : [])),
    onPick: () => "handled",
  };
  const threads: InputTriggerSource = {
    trigger: "@",
    aliases: ["#"],
    name: "threads",
    launcher: "command",
    order: 25,
    subscribeCandidates: (_, listener) => {
      invalidate = listener;
      return () => {
        invalidate = undefined;
      };
    },
    candidates: vi.fn(async (_, req) => ("target".includes(req.query) ? [{ name: "target" }] : [])),
    onPick: () => ({
      insert: {
        source: "threads",
        ref: "thread://target?hostId=local",
        label: "Target",
        appearance: "session",
      },
    }),
  };
  const agents: InputTriggerSource = {
    trigger: "@",
    name: "agents",
    candidates: vi.fn(async () => [{ name: "agent" }]),
    onPick: () => "handled",
  };
  const sameName: InputTriggerSource = {
    trigger: "@",
    name: "command",
    candidates: vi.fn(async () => [{ name: "unrelated" }]),
    onPick: () => "handled",
  };
  const sources = [threads, agents, commands, sameName];
  const controller = new InputTriggerController({
    actx: { bail } as unknown as Context,
    sessionId: "destination" as SessionId,
    roster: {
      all: () => sources,
      sources: (trigger) => sources.filter((source) => sourceMatchesTrigger(source, trigger)),
    },
  });
  const span = { start: 7, end: 7, draftRev: 1 };
  const open = () =>
    controller.toggleSource("command", {
      trigger: "/",
      query: "",
      quoted: false,
      position: "inline",
      span,
    });
  return {
    controller,
    open,
    bail,
    span,
    threads,
    agents,
    sameName,
    invalidate: () => invalidate?.(),
  };
}

describe("launcher-only reference sources", () => {
  it("shares launcher membership across trigger types, refreshes, searches and picks the saved span", async () => {
    const f = fixture();
    f.open();
    await vi.waitFor(() =>
      expect(
        f.controller.menu.getSnapshot().groups.every((group) => group.status === "ready"),
      ).toBe(true),
    );
    expect(f.controller.menu.getSnapshot().groups.map((group) => group.source)).toEqual([
      "command",
      "threads",
    ]);
    expect(f.agents.candidates).not.toHaveBeenCalled();
    expect(f.sameName.candidates).not.toHaveBeenCalled();
    f.controller.sourceRemoved(f.sameName);
    expect(f.controller.menu.getSnapshot().groups.map((group) => group.source)).toEqual([
      "command",
      "threads",
    ]);
    expect(f.bail).not.toHaveBeenCalled();
    f.invalidate();
    await vi.waitFor(() => expect(f.threads.candidates).toHaveBeenCalledTimes(2));
    f.controller.searchLauncher("unmatched");
    await vi.waitFor(() =>
      expect(
        f.controller.menu
          .getSnapshot()
          .groups.every((group) => group.status === "ready" && group.items.length === 0),
      ).toBe(true),
    );
    expect(f.controller.menu.getSnapshot().open).toBe(true);
    expect(f.controller.menu.getSnapshot().highlight).toBeNull();
    expect(f.bail).not.toHaveBeenCalled();
    f.controller.searchLauncher("target");
    await vi.waitFor(() =>
      expect(f.controller.menu.getSnapshot().highlight?.source).toBe("threads"),
    );
    f.controller.pick("threads", 0);
    expect(f.bail).toHaveBeenCalledWith(expect.anything(), "slash/input-insert-reference", {
      reference: {
        source: "threads",
        ref: "thread://target?hostId=local",
        label: "Target",
        appearance: "session",
      },
      span: f.span,
    });
    expect(f.controller.menu.getSnapshot().open).toBe(false);
    expect(f.controller.launcher.getSnapshot()).toBeNull();
    f.controller.dispose();
  });

  it("does not add launcher-only sources to typed slash, and closes unmatched typed queries", async () => {
    const f = fixture();
    f.controller.track("/missing", 8, { tier: "plain" }, 1);
    await vi.waitFor(() => expect(f.controller.menu.getSnapshot().open).toBe(false));
    expect(f.threads.candidates).not.toHaveBeenCalled();
    expect(f.agents.candidates).not.toHaveBeenCalled();
    f.controller.dispose();
  });
});

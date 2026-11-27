import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { describe, expect, it, vi } from "vitest";
import { InputTriggerController } from "../src/client/controller.ts";
import { sourceMatchesTrigger } from "../src/core/source.ts";
import type { InputTriggerSource } from "../src/types.ts";

function createController(initialSources: InputTriggerSource[]) {
  const sources = [...initialSources];
  const controller = new InputTriggerController({
    actx: {} as Context,
    sessionId: "session-1" as SessionId,
    roster: {
      sources: (trigger) =>
        sources
          .filter((source) => sourceMatchesTrigger(source, trigger))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      all: () => sources,
    },
  });
  return { controller, sources };
}

describe("InputTriggerController lexicon notifications", () => {
  it("does not notify lexicon subscribers on candidate-only invalidations while still refreshing open menus", async () => {
    let notifyCandidates: (() => void) | undefined;
    const candidates = vi.fn(async () => [{ name: "thread-1", label: "Thread 1" }]);
    const source: InputTriggerSource = {
      trigger: "@",
      name: "threads",
      candidates,
      subscribeCandidates: (_session, listener) => {
        notifyCandidates = listener;
        return () => {
          notifyCandidates = undefined;
        };
      },
      onPick: () => "handled",
    };

    const { controller } = createController([source]);
    const lexiconListener = vi.fn();
    const off = controller.lexicon.subscribe(lexiconListener);
    try {
      notifyCandidates?.();
      notifyCandidates?.();
      expect(lexiconListener).not.toHaveBeenCalled();

      // When a menu is open, candidate-only invalidations still refresh candidates without touching lexicon.
      controller.track("@", 1, { tier: "plain" }, 1);
      expect(candidates).toHaveBeenCalledTimes(1);
      notifyCandidates?.();
      await Promise.resolve();
      expect(candidates).toHaveBeenCalledTimes(2);
      expect(lexiconListener).not.toHaveBeenCalled();
    } finally {
      off();
      controller.dispose();
    }
  });

  it("skips redundant lexicon notifications when rolls are unchanged and notifies when they change", () => {
    let notifyLexicon: (() => void) | undefined;
    let names: readonly string[] = ["plan", "review"];
    const lexiconSource: InputTriggerSource = {
      trigger: "/",
      name: "skills",
      candidates: async () => [],
      lexicon: () => names,
      subscribeLexicon: (_session, listener) => {
        notifyLexicon = listener;
        return () => {
          notifyLexicon = undefined;
        };
      },
      onPick: () => "handled",
    };
    const extraNonLexiconSource: InputTriggerSource = {
      trigger: "/",
      name: "screenshot",
      candidates: async () => [],
      onPick: () => "handled",
    };

    const { controller, sources } = createController([lexiconSource]);
    const lexiconListener = vi.fn();
    const off = controller.lexicon.subscribe(lexiconListener);
    try {
      // Same entries (even as a fresh array) must not emit.
      names = ["plan", "review"];
      notifyLexicon?.();
      expect(lexiconListener).not.toHaveBeenCalled();

      // Adding or removing a source without lexicon must not emit.
      sources.push(extraNonLexiconSource);
      controller.sourceAdded(extraNonLexiconSource);
      sources.pop();
      controller.sourceRemoved(extraNonLexiconSource);
      expect(lexiconListener).not.toHaveBeenCalled();

      // Actual roll change emits once with the updated names.
      names = ["plan", "review", "deploy"];
      notifyLexicon?.();
      expect(lexiconListener).toHaveBeenCalledTimes(1);
      expect(controller.lexicon.getSnapshot().get("/")).toEqual(["plan", "review", "deploy"]);
    } finally {
      off();
      controller.dispose();
    }
  });

  it("coalesces same-turn invalidations into one microtask and refetches only invalidated sources", async () => {
    const notifiers = new Map<string, () => void>();
    const inflightSignals = new Map<string, AbortSignal[]>();
    const pendingHealthy = Promise.withResolvers<[{ name: string; label: string }]>();
    let healthyCalls = 0;

    const makeSource = (name: string, slow = false): InputTriggerSource => ({
      trigger: "#",
      name,
      candidates: vi.fn(async (_session, req) => {
        const list = inflightSignals.get(name) ?? [];
        list.push(req.signal);
        inflightSignals.set(name, list);
        if (slow) {
          healthyCalls += 1;
          return pendingHealthy.promise;
        }
        return [{ name: `${name}-item`, label: `${name} item` }];
      }),
      subscribeCandidates: (_session, listener) => {
        notifiers.set(name, listener);
        return () => {
          notifiers.delete(name);
        };
      },
      onPick: () => "handled",
    });

    const sourceA = makeSource("agents");
    const sourceB = makeSource("commands");
    const sourceC = makeSource("files", true);

    const { controller } = createController([sourceA, sourceB, sourceC]);
    try {
      controller.track("#", 1, { tier: "plain" }, 1);
      expect(sourceA.candidates).toHaveBeenCalledTimes(1);
      expect(sourceB.candidates).toHaveBeenCalledTimes(1);
      expect(sourceC.candidates).toHaveBeenCalledTimes(1);

      // Multiple invalidations in the same turn coalesce into one microtask and
      // only refetch invalidated sources (leaving healthy in-flight sourceC untouched).
      notifiers.get("agents")?.();
      notifiers.get("agents")?.();
      notifiers.get("commands")?.();
      await Promise.resolve();

      expect(sourceA.candidates).toHaveBeenCalledTimes(2);
      expect(sourceB.candidates).toHaveBeenCalledTimes(2);
      expect(sourceC.candidates).toHaveBeenCalledTimes(1);
      expect(healthyCalls).toBe(1);
      expect(inflightSignals.get("files")?.[0]?.aborted).toBe(false);

      pendingHealthy.resolve([{ name: "file-1", label: "src/index.ts" }]);
      await Promise.resolve();
      await Promise.resolve();
      const filesGroup = controller.menu.getSnapshot().groups.find((g) => g.source === "files");
      expect(filesGroup?.status).toBe("ready");
      expect(filesGroup?.items).toEqual([{ name: "file-1", label: "src/index.ts" }]);
    } finally {
      controller.dispose();
    }
  });
});

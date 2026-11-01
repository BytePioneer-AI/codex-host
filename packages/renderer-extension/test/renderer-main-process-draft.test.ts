import { installRendererDraftPrewarmPolicyDirect } from "@codexhost/desktop-control";
import { decodeHarnessPluginRoute } from "@codexhost/shared-contracts";
import { afterEach, expect, it, vi } from "vitest";

import type { RendererAgent } from "../src/agent-selection-state.js";
import { installCurrentRendererAdapter } from "../src/versioned-renderer-adapter.js";

type Draft = Record<string, unknown> & { modelSettings: { model: string } };
type CreateInput = {
  cwd: string;
  input: { type: string; text: string }[];
  collaborationMode: { mode: string; settings: { model: string; reasoning_effort: string } };
};

async function setup() {
  const draftId = "client-new-thread:main-process";
  const sent: { message: unknown; transfer: unknown }[] = [];
  class MessagePort {
    postMessage(message: unknown, transfer?: unknown): void {
      sent.push({ message, transfer });
    }
  }
  const port = new MessagePort();
  const rpc = {
    sendRequest: vi.fn(async () => null),
    clearPrewarmedThreads: vi.fn(async () => undefined),
  };
  const family = new Map([
    ["local", { value: { get: () => ({ status: "ready", client: { hostId: "local", rpc } }) } }],
  ]);
  const scope = { familyBindings: new Map([[{ kind: "signal-family" }, family]]) };
  const handle = {
    node: { parent: scope },
    chain: {},
    scope: {},
    get: vi.fn(),
    set: vi.fn(),
    watch: vi.fn(),
  };
  const root = {
    __reactContainer$test: {
      memoizedState: { memoizedState: { current: handle }, next: null },
    },
  };
  const originals: CreateInput[] = [];
  const transfer: unknown[] = [];
  const create = (id = draftId, model = "official-catalog-model"): void => {
    // The native catalog keeps its official Model after an external draft write.
    const input: CreateInput = {
      cwd: "/workspace",
      input: [{ type: "text", text: "hello" }],
      collaborationMode: { mode: "default", settings: { model, reasoning_effort: "high" } },
    };
    originals.push(input);
    port.postMessage(
      ["push", ["pipeline", -188, ["startConversation"], [input, { clientThreadId: id }]]],
      transfer,
    );
  };
  let draft: Draft = { modelSettings: { model: "official-catalog-model" } };
  const row = Array<unknown>(14).fill(null);
  const update = (edit: (current: Draft) => Draft): void => {
    draft = edit(draft);
    row[10] = draft;
    (row[13] as { draftSettings: Draft }).draftSettings = draft;
    create();
  };
  Object.assign(row, {
    6: draftId,
    7: draftId,
    9: update,
    10: draft,
    11: true,
    12: update,
    13: { draftSettings: draft, isNewThreadDraft: true, updateDraftSettings: update },
  });
  const context = { usesAccountPreferences: false, modelSettings: draft.modelSettings };
  const setModel = vi.fn();
  const modelRow = Object.assign(Array<unknown>(24).fill(null), {
    7: null,
    10: true,
    12: context,
    13: update,
    14: setModel,
    20: setModel,
    21: context,
    23: { ...context, setModelAndReasoningEffort: setModel },
  });
  const editor = {
    matches: () => true,
    querySelector: () => null,
    parentElement: null,
    __reactFiber$test: {
      memoizedProps: { executionTargetHostId: "local" },
      updateQueue: { memoCache: { data: [row, modelRow] } },
      return: null,
    },
  } as unknown as Element;
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", {
    querySelector: () => editor,
    querySelectorAll: () => [editor],
    getElementById: (id: string) => (id === "root" ? root : null),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    documentElement: {},
  });
  vi.stubGlobal("MessagePort", MessagePort);
  await installRendererDraftPrewarmPolicyDirect({
    async evaluate<T>(source: string): Promise<T> {
      return new Function(`return ${source}`)();
    },
  });
  const adapter = installCurrentRendererAdapter();
  return { adapter, editor, sent, originals, transfer, create };
}

afterEach(() => {
  window.__codexhostHostRoutingV1?.dispose();
  vi.unstubAllGlobals();
});

function inputOf(message: unknown): CreateInput {
  const expression = (message as unknown[])[1] as unknown[];
  return (expression[3] as CreateInput[])[0] as CreateInput;
}

it.each<RendererAgent>(["claude-code", "antigravity", "deepseek-harness", "pi"])(
  "connects the main-process adapter and routes %s after the catalog filters its Model",
  async (agent) => {
    const f = await setup();
    try {
      expect(f.adapter.status).toMatchObject({ state: "ready", hook: "request-bridge" });
      expect(f.adapter.applyAgent(agent, undefined, undefined, undefined, f.editor)).toBe(true);
      const first = f.sent[0];
      expect(first).toBeDefined();
      const input = inputOf(first?.message);
      expect(decodeHarnessPluginRoute(input.collaborationMode.settings.model)?.harnessId).toBe(
        agent,
      );
      expect(input).toEqual({
        ...f.originals[0],
        collaborationMode: {
          mode: "default",
          settings: {
            ...f.originals[0]?.collaborationMode.settings,
            model: input.collaborationMode.settings.model,
          },
        },
      });
      expect(first?.transfer).toBe(f.transfer);
      expect(f.originals[0]?.collaborationMode.settings.model).toBe("official-catalog-model");

      f.create("client-new-thread:other");
      expect(inputOf(f.sent.at(-1)?.message)).toBe(f.originals.at(-1));
      expect(f.adapter.applyAgent("codex", undefined, undefined, undefined, f.editor)).toBe(true);
      expect(inputOf(f.sent.at(-1)?.message).collaborationMode.settings.model).toBe(
        "official-catalog-model",
      );
    } finally {
      f.adapter.dispose();
    }
  },
);

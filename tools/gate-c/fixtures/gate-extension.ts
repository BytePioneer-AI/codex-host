import { Type } from "typebox";

export default function gateExtension(pi) {
  pi.on("input", async (event, ctx) => {
    if (event.text !== "gate-preflight") return { action: "continue" };
    const value = await ctx.ui.select("Gate preflight", ["continue", "cancel"]);
    ctx.ui.notify(`Gate preflight result: ${value ?? "cancelled"}`, "info");
    return { action: "handled" };
  });

  pi.registerCommand("gate-no-agent", {
    description: "Complete without starting an agent loop",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Gate command completed", "info");
    },
  });

  pi.registerCommand("gate-select", {
    description: "Exercise RPC select",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.select("Gate select", ["alpha", "beta"]);
      ctx.ui.notify(`select:${value ?? "cancelled"}`, "info");
    },
  });

  pi.registerCommand("gate-confirm", {
    description: "Exercise RPC confirm",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.confirm("Gate confirm", "Allow the synthetic action?");
      ctx.ui.notify(`confirm:${value}`, "info");
    },
  });

  pi.registerCommand("gate-input", {
    description: "Exercise RPC input",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input("Gate input", "synthetic value");
      ctx.ui.notify(`input:${value ?? "cancelled"}`, "info");
    },
  });

  pi.registerCommand("gate-editor", {
    description: "Exercise RPC editor",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.editor("Gate editor", "synthetic line");
      ctx.ui.notify(`editor:${value ?? "cancelled"}`, "info");
    },
  });

  pi.registerCommand("gate-timeout", {
    description: "Exercise an RPC dialog timeout",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.select("Gate timeout", ["late"], { timeout: 50 });
      ctx.ui.notify(`timeout:${value ?? "expired"}`, "info");
    },
  });

  pi.registerCommand("gate-navigate", {
    description: "Navigate the current session tree to a synthetic target entry",
    handler: async (entryId, ctx) => {
      await ctx.navigateTree(entryId.trim(), { summarize: false });
    },
  });

  pi.registerTool({
    name: "gate_question",
    label: "Gate Question",
    description: "Ask one controlled question for the codexhost Gate C scenario",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const value = await ctx.ui.select("Gate tool question", ["continue", "stop"], {
        signal,
      });
      return {
        content: [{ type: "text", text: `Gate question result: ${value ?? "cancelled"}` }],
        details: { answered: value !== undefined },
      };
    },
  });

  pi.registerTool({
    name: "gate_long_tool",
    label: "Gate Long Tool",
    description: "Wait until cancelled for the codexhost Gate C scenario",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "synthetic progress" }], details: {} });
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      return {
        content: [{ type: "text", text: "Gate long tool stopped" }],
        details: { cancelled: signal.aborted },
      };
    },
  });

  pi.registerTool({
    name: "gate_custom",
    label: "Gate Custom",
    description: "Emit deterministic cumulative updates for the codexhost Gate C scenario",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "phase 1" }], details: { phase: 1 } });
      onUpdate?.({
        content: [{ type: "text", text: "phase 1 phase 2" }],
        details: { phase: 2 },
      });
      return {
        content: [{ type: "text", text: "Gate custom complete" }],
        details: { complete: true },
      };
    },
  });

  pi.registerTool({
    name: "gate_failure",
    label: "Gate Failure",
    description: "Fail deterministically for the codexhost Gate C scenario",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("synthetic gate tool failure");
    },
  });
}

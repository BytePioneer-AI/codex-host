import { createRequire } from "node:module";
import { describe, it, expect, vi } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { NativeInteractions as PublicInteractions } from "../src/interactions.js";
import { approvalDescription } from "../src/approvals.js";
import { readInspection } from "../src/protocol.js";
const { approvalDecision, NativeInteractions } = createRequire(import.meta.url)(
  "../assets/companion/interactions.cjs",
);
const input = {
  kind: "approval",
  sessionId: "session",
  messageId: "user",
  planItemId: "plan",
  interactionId: "instance",
  action: "allowOnce",
};
function setup(
  name: string,
  params: Record<string, unknown>,
  confirm: Record<string, unknown> = {},
) {
  const plan = {
    id: "plan",
    task_id: "task",
    reply_to_message_id: "user",
    tool_call_info: { id: "native-call", name, params },
    confirm_info: {
      confirm_status: "unconfirmed",
      auto_confirm: false,
      interaction_instance_id: "instance",
      ...confirm,
    },
  };
  const native = new NativeInteractions();
  native.observe("session", { event: "plan_item", payload: plan });
  return { plan, current: native.current("session", "user", "plan") };
}
describe("TRAE CN native file and MCP approvals", () => {
  it("does not offer file approvals through an old Companion or accept malformed capability markers", () => {
    const test = setup("Edit", { file_path: "/workspace/owned" }),
      outputs: HarnessOutput[] = [],
      call = vi.fn();
    const interactions = new PublicInteractions(
      { sessionId: "session", messageId: "user", turnId: hostTurnIdSchema.parse("host") },
      { call },
      (output) => outputs.push(output),
    );
    expect(() => interactions.observe(test.plan)).toThrow("Update the TRAE CN Companion");
    expect(outputs).toEqual([]);
    expect(call).not.toHaveBeenCalled();
    const inspection = {
      application: { name: "Trae CN", version: "fixture", root: "/app", executable: "/app/trae" },
      instanceId: "fixture",
      workspaceFolders: ["/workspace"],
      agentType: "builder_v3",
      models: [],
    };
    expect(readInspection(inspection).interactions).toBeUndefined();
    expect(
      readInspection({ ...inspection, interactions: { fileAndMcpApprovals: true } }).interactions,
    ).toEqual({ fileAndMcpApprovals: true });
    expect(() =>
      readInspection({ ...inspection, interactions: { fileAndMcpApprovals: "true" } }),
    ).toThrow("approval capabilities");
  });
  it("omits new-system permission scopes for a legacy native confirmation", () => {
    for (const test of [
      setup("Edit", { file_path: "/workspace/owned" }),
      setup("RunCommand", { command: "echo owned" }),
      setup(
        "run_mcp",
        { server_name: "fixture", tool_name: "read" },
        {
          permission_request_reason: "mcp_rule_ask",
          permission_request_mcp_tools: ["fixture/read"],
        },
      ),
    ]) {
      expect(approvalDecision(test.current, input, false).permission_scope).toBeUndefined();
      expect(
        approvalDecision(test.current, { ...input, action: "deny" }, false).permission_scope,
      ).toBeUndefined();
    }
  });
  it.each(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"])(
    "confirms %s with the event-owned tool-call ID and per-execution scope",
    (name) => {
      const test = setup(name, { file_path: "/workspace/owned.txt" });
      expect(approvalDecision(test.current, { ...input, toolcall_id: "attacker" })).toEqual({
        chat_session_id: "session",
        task_id: "task",
        plan_item_id: "plan",
        toolcall_id: "native-call",
        interaction_instance_id: "instance",
        type: "tool_confirm",
        decision: "confirm",
        permission_scope: "execution",
      });
      expect(approvalDecision(test.current, { ...input, action: "deny" })).toMatchObject({
        tool_name: name,
        decision: "skip",
        permission_scope: "none",
      });
    },
  );
  it("uses the native deletion decision shape and preserves all target paths", () => {
    const test = setup("DeleteFile", { file_paths: ["/workspace/one", "/workspace/two"] });
    const allowed = approvalDecision(test.current, input),
      denied = approvalDecision(test.current, { ...input, action: "deny" });
    expect(allowed).toMatchObject({ toolcall_id: "native-call", decision: "confirm" });
    expect(allowed.permission_scope).toBeUndefined();
    expect(allowed.tool_name).toBeUndefined();
    expect(denied).toMatchObject({ tool_name: "DeleteFile", decision: "skip" });
    expect(denied.permission_scope).toBeUndefined();
    const definition = approvalDescription(
      test.plan.tool_call_info,
      test.plan.tool_call_info.params,
      test.plan.confirm_info,
    );
    expect(definition?.description).toContain("/workspace/one");
    expect(definition?.description).toContain("/workspace/two");
    expect(definition?.title).toContain("删除");
  });
  it.each(["run_mcp", "ReadMcpResource"])(
    "preserves %s native scope rules without granting persistent access",
    (name) => {
      const params =
        name === "run_mcp"
          ? { server_name: "fixture", tool_name: "read", args: { path: "owned" } }
          : { server: "fixture", uri: "resource://owned" };
      const test = setup(name, params, {
        permission_request_reason: "mcp_rule_ask",
        permission_request_mcp_tools: ["fixture/read"],
      });
      expect(approvalDecision(test.current, input)).toMatchObject({
        tool_name: name,
        permission_scope: "execution",
      });
      expect(approvalDecision(test.current, { ...input, action: "deny" })).toMatchObject({
        decision: "skip",
        permission_scope: "none",
      });
      const legacy = setup(name, params);
      expect(approvalDecision(legacy.current, input).permission_scope).toBeUndefined();
      expect(() => approvalDecision(test.current, { ...input, action: "allowAlways" })).toThrow(
        "Unknown native approval action",
      );
    },
  );
  it("rejects missing native identities, unknown tools and oversized arguments before confirmation", () => {
    const file = setup("Edit", { file_path: "/workspace/owned" });
    delete (file.plan.tool_call_info as { id?: string }).id;
    file.current.plan.tool_call_info.id = undefined;
    expect(() => approvalDecision(file.current, input)).toThrow("tool-call identity");
    expect(() =>
      approvalDescription(
        file.plan.tool_call_info,
        file.plan.tool_call_info.params,
        file.plan.confirm_info,
      ),
    ).toThrow("tool-call identity");
    const unknown = setup("unknown", {});
    expect(() => approvalDecision(unknown.current, input)).toThrow("not implemented");
    const large = setup("run_mcp", {
      server_name: "fixture",
      tool_name: "read",
      args: { text: "中".repeat(6000) },
    });
    expect(() => approvalDecision(large.current, input)).toThrow("16 KiB");
    expect(() =>
      approvalDescription(
        large.plan.tool_call_info,
        large.plan.tool_call_info.params,
        large.plan.confirm_info,
      ),
    ).toThrow("16 KiB");
  });
  it("publishes and responds to one public file interaction without accepting duplicate or permanent replies", async () => {
    const test = setup(
      "Edit",
      { file_path: "/workspace/owned.txt" },
      {
        permission_request_rw_paths: ["/workspace/owned.txt"],
        permission_request_reason: "permission_request",
      },
    );
    const outputs: HarnessOutput[] = [],
      call = vi.fn(async () => ({ accepted: true }));
    const interactions = new PublicInteractions(
      { sessionId: "session", messageId: "user", turnId: hostTurnIdSchema.parse("host") },
      { call },
      (output) => outputs.push(output),
      true,
    );
    interactions.observe(test.plan);
    interactions.observe(test.plan);
    const opened = outputs.find((output) => output.kind === "interaction");
    if (!opened || opened.kind !== "interaction" || opened.interaction.type !== "approval")
      throw new Error("No public approval");
    expect(opened.interaction.description).toContain("/workspace/owned.txt");
    expect(opened.interaction.actions.map((action) => action.effect)).toEqual([
      "allowOnce",
      "deny",
    ]);
    const command = {
      type: "interaction.respond" as const,
      interactionId: opened.interaction.interactionId,
      response: { type: "approval" as const, actionId: "allowOnce" },
    };
    expect(
      await interactions.respond({
        ...command,
        response: { type: "approval", actionId: "allowAlways" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(call).not.toHaveBeenCalled();
    expect(await interactions.respond(command)).toMatchObject({ ok: true });
    expect(await interactions.respond(command)).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(call).toHaveBeenCalledExactlyOnceWith("respond", {
      kind: "approval",
      sessionId: "session",
      messageId: "user",
      planItemId: "plan",
      interactionId: "instance",
      action: "allowOnce",
    });
    expect(outputs.filter((output) => output.kind === "interaction")).toHaveLength(1);
    expect(
      outputs.filter(
        (output) => output.kind === "event" && output.event.type === "interaction.closed",
      ),
    ).toHaveLength(1);
  });
});

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { DesktopService, publicEvent, publicHistoryItem, publicTokenUsage } = createRequire(
  import.meta.url,
)("../assets/companion/service.cjs");

const model = {
  name: "configured",
  display_name: "Configured",
  status: true,
  selectable: true,
  provider: "fixture-provider",
  ak: "fixture-private-key",
  client_connect: true,
  config_source: 3,
};

function setup() {
  const call = vi.fn<
    (service: string, method: string, data?: unknown, context?: unknown) => Promise<unknown>
  >(async (service: string, method: string) => {
    if (service === "model") return { list: [{ function: "builder_v3", models: [model] }] };
    if (method === "create_chat_session")
      return { chat_session_id: "session", local_project_id: "project" };
    if (method === "get_or_create_project_v2")
      return { project_id: "project", workspace_folders: ["/workspace"] };
    if (method === "get_chat_session")
      return { chat_session_id: "session", local_project_id: "project", status: 6 };
    if (method === "get_messages") return { items: [], next_page_token: null };
    return { accepted: true, status: "in_progress" };
  });
  const native = { call, subscribe: vi.fn() };
  return {
    call,
    native,
    service: new DesktopService(native, { name: "Trae CN", version: "fixture" }, ["/workspace"]),
  };
}

describe("TRAE CN desktop bridge service", () => {
  it("validates the scoped native permission and puts it on both request policy fields", async () => {
    const test = setup();
    const permissions = {
      modes: [
        { id: "manual_approval", label: "Manual" },
        { id: "full_access", label: "Full", dangerous: true },
      ],
      defaultModeId: "manual_approval",
    };
    const service = new DesktopService(
      test.native,
      { name: "Trae CN", version: "fixture" },
      ["/workspace"],
      "builder_v3",
      undefined,
      undefined,
      undefined,
      async () => permissions,
    );
    expect((await service.inspect()).permissions).toEqual(permissions);
    expect(
      await service.call("preparePermission", {
        sessionId: "session",
        permissionModeId: "full_access",
      }),
    ).toEqual({ permissionModeId: "full_access" });
    expect(test.call.mock.calls.some(([, method]) => method === "send_message")).toBe(false);
    await expect(
      service.call("preparePermission", { permissionModeId: "removed" }),
    ).rejects.toMatchObject({ code: "invalidRequest" });
    expect(
      await service.call("start", {
        sessionId: "session",
        modelId: model.name,
        text: "hello",
        permissionModeId: "full_access",
      }),
    ).toMatchObject({ accepted: true, permissionModeId: "full_access" });
    const request = test.call.mock.calls.find(([, method]) => method === "send_message");
    expect(request?.[2]).toMatchObject({ permission_profile_id: "full_access" });
    expect(request?.[3]).toMatchObject({ permission_profile_id: "full_access" });
    expect(
      test.call.mock.calls.some(([, method]) =>
        /write|set.*permission|update.*config/i.test(method),
      ),
    ).toBe(false);
  });
  it("validates scoped model preparation without creating a Session or changing native preferences", async () => {
    const { service, call } = setup();
    expect(
      await service.call("prepareModel", { modelId: model.name, sessionId: "session" }),
    ).toEqual({ agentType: "builder_v3", modelId: model.name });
    expect(call.mock.calls.map(([, method]) => method)).toEqual([
      "get_chat_session",
      "get_or_create_project_v2",
      "model_list_by_function",
    ]);
    call.mockClear();
    await expect(
      service.call("prepareModel", { modelId: model.name, sessionId: "foreign" }),
    ).rejects.toThrow("different session");
    expect(call.mock.calls.map(([, method]) => method)).toEqual(["get_chat_session"]);
  });
  it("exports reliable numeric counters without treating native display strings as usage", () => {
    expect(
      publicTokenUsage({
        prompt_tokens: 42,
        max_tokens: 100,
        input: "0.000",
        output: "0.000",
        prompt_tokens_total: 0,
        token: "private",
        reasoning_tokens: -1,
        completion_tokens: 1.5,
      }),
    ).toEqual({ prompt_tokens: 42, prompt_tokens_total: 0, max_tokens: 100 });
    expect(publicTokenUsage({ input: "42.000", output: "0.001" })).toBeUndefined();
    expect(
      publicHistoryItem({
        token_usage: JSON.stringify({
          last_turn_total_tokens: 10,
          max_tokens: 100,
          internal: "private",
        }),
      }),
    ).toEqual({ tokenUsage: { last_turn_total_tokens: 10, max_tokens: 100 } });
  });
  it("reads native message diffs using the validated project and original user message", async () => {
    const { service, call } = setup();
    const original = call.getMockImplementation();
    call.mockImplementation(async (kind, method, ...args) => {
      if (method === "get_messages")
        return {
          items: [
            {
              chat_session_id: "session",
              message_id: "assistant",
              reply_to_message_id: "user",
              role: "assistant",
              status: "completed",
              content: JSON.stringify({
                messages: [
                  {
                    type: "plan_item",
                    plan_item: {
                      id: "edit",
                      tool_call_info: { name: "Edit", result: { data: { can_show_diff: true } } },
                    },
                  },
                ],
              }),
            },
          ],
        };
      if (method === "get_message_ai_edit_file_diff_list")
        return {
          file_diffs: [
            {
              file_path: "/workspace/file",
              file_action: "modified",
              before_content: "old",
              after_content: "new",
              internal: "not public",
            },
          ],
        };
      return original?.(kind, method, ...args);
    });
    const snapshot = await service.call("snapshot", { sessionId: "session" });
    expect(snapshot.items[0]).toMatchObject({
      fileDiffs: [
        {
          file_path: "/workspace/file",
          file_action: "modified",
          before_content: "old",
          after_content: "new",
        },
      ],
      fileDiffSourceIds: ["edit"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("not public");
    expect(call).toHaveBeenCalledWith("snapshot", "get_message_ai_edit_file_diff_list", {
      project_id: "project",
      session_id: "session",
      message_id: "user",
    });
    call.mockClear();
    await expect(service.call("snapshot", { sessionId: "foreign" })).rejects.toThrow(
      "different session",
    );
    expect(
      call.mock.calls.some(([, method]) => method === "get_message_ai_edit_file_diff_list"),
    ).toBe(false);
  });
  it("binds a native workspace Project before creating its Session", async () => {
    const { service, call } = setup();
    expect(await service.call("create", { cwd: "/workspace" })).toEqual({
      sessionId: "session",
      projectId: "project",
    });
    expect(call.mock.calls).toEqual([
      [
        "lite",
        "get_or_create_project_v2",
        {
          project_kind: "workspace",
          workspace_type: "single_root",
          single_root_workspace_folder: "/workspace",
          workspace_folders: ["/workspace"],
        },
      ],
      [
        "lite",
        "create_chat_session",
        { title: "CodexHost", local_project_id: "project", session_type: "side_chat" },
        { project_id: "project" },
      ],
    ]);
    call.mockClear();
    await expect(service.call("create", { cwd: "/another-workspace" })).rejects.toThrow(
      "folder open",
    );
    expect(call).not.toHaveBeenCalled();
  });
  it("inspects conversation models without creating a native session or exporting credentials", async () => {
    const { service, call } = setup();
    const inspection = await service.inspect();
    expect(inspection.models).toEqual([
      { id: "configured", label: "Configured", provider: "fixture-provider", multimodal: false },
    ]);
    expect(JSON.stringify(inspection)).not.toContain("fixture-private-key");
    expect(call).toHaveBeenCalledExactlyOnceWith("model", "model_list_by_function", {
      functions: ["builder_v3"],
      force_refresh: false,
    });
  });

  it("constructs native model configuration inside the app and ignores client credential injection", async () => {
    const { service, call } = setup();
    await service.call("start", {
      sessionId: "session",
      projectId: "project",
      messageId: "message",
      modelId: "configured",
      text: "hello",
      custom_model: { ak: "attacker" },
      user_info: { token: "attacker" },
      permission_profile_id: "attacker",
    });
    const request = call.mock.calls.find((args) => args[1] === "send_message");
    expect(request).toMatchObject([
      "lite",
      "send_message",
      {
        chat_session_id: "session",
        message_id: "message",
        permission_profile_id: "manual_approval",
        custom_model: { ak: "fixture-private-key", use_remote_service: false },
        content: [{ type: "text", text_content: "hello" }],
      },
      { chat_session_id: "session", project_id: "project" },
    ]);
    expect(JSON.stringify(request)).not.toContain("attacker");
  });

  it("requires a manually selected, currently available model before sending", async () => {
    const { service, call } = setup();
    await expect(service.call("start", { sessionId: "session", text: "hello" })).rejects.toThrow(
      "model ID",
    );
    await expect(
      service.call("start", { sessionId: "session", modelId: "removed", text: "hello" }),
    ).rejects.toThrow("no longer available");
    expect(call.mock.calls.every((args) => args[1] !== "send_message")).toBe(true);
  });

  it("uses the desktop-owned question settings instead of client-supplied feature flags", async () => {
    const { native, call } = setup();
    const settings = vi.fn(async () => ({
      ask_question_config: { feature_available: false, ide_enable: false, solo_enable: false },
    }));
    const service = new DesktopService(
      native,
      { name: "Trae CN", version: "fixture" },
      ["/workspace"],
      "builder_v3",
      settings,
    );
    await service.inspect();
    expect(settings).not.toHaveBeenCalled();
    await service.call("start", {
      sessionId: "session",
      modelId: "configured",
      text: "hello",
      ask_question_config: { feature_available: true, ide_enable: true, solo_enable: true },
    });
    expect(settings).toHaveBeenCalledOnce();
    expect(call.mock.calls.find((args) => args[1] === "send_message")?.[2]).toMatchObject({
      ask_question_config: { feature_available: false, ide_enable: false, solo_enable: false },
    });
  });

  it("does not expose model credentials from serialized history or metadata", () => {
    const context = {
      model_info: {
        config_name: "configured",
        display_model_name: "Configured",
        ak: "fixture-private-key",
        base_url: "https://private-provider.invalid",
        sk: "fixture-secret",
      },
      token: "fixture-login",
    };
    const item = publicHistoryItem({
      message_id: "message",
      chat_session_id: "session",
      role: "assistant",
      content: '{"task_id":"task","messages":[]}',
      user_message_context: JSON.stringify(context),
      user_id: "private-user",
    });
    const event = publicEvent({
      event: "metadata",
      payload: { message_id: "message", user_message_context: context },
    });
    expect(item.model).toEqual({ config_name: "configured", display_model_name: "Configured" });
    expect(event.payload.model).toEqual(item.model);
    expect(JSON.stringify({ item, event })).not.toMatch(
      /fixture-private|fixture-secret|fixture-login|private-provider|private-user/,
    );
  });

  it("keeps visible tool results and rejects unsupported native events explicitly", () => {
    const payload = { tool_call_info: { name: "finish", params: { summary: "OK" } } };
    expect(publicEvent({ event: "plan_item", payload }).payload).toEqual(payload);
    expect(() => publicEvent({ event: "unimplemented-native-control", payload: {} })).toThrow(
      "Unsupported TRAE CN event",
    );
  });

  it("rejects a mismatched session and repeated history cursors", async () => {
    const { service, call } = setup();
    await expect(service.call("snapshot", { sessionId: "different" })).rejects.toThrow(
      "different session",
    );
    call.mockImplementation(async (_service: string, method: string) =>
      method === "get_chat_session"
        ? { chat_session_id: "session", local_project_id: "project", status: 6 }
        : method === "get_or_create_project_v2"
          ? { project_id: "project", workspace_folders: ["/workspace"] }
          : { items: [], next_page_token: "repeat" },
    );
    await expect(service.call("snapshot", { sessionId: "session" })).rejects.toThrow(
      "history cursor",
    );
  });

  it("requests cancellation without manufacturing native completion", async () => {
    const { service, call } = setup();
    await service.call("cancel", { sessionId: "session" });
    expect(call).toHaveBeenCalledWith("lite", "stop_chat_session", {
      chat_session_id: "session",
    });
  });

  it("rejects a Session from another native Project workspace before writing", async () => {
    const { service, call } = setup();
    const original = call.getMockImplementation();
    if (!original) throw new Error("Missing native fixture implementation");
    call.mockImplementation(async (...args) =>
      args[1] === "get_or_create_project_v2"
        ? { project_id: "project", workspace_folders: ["/different"] }
        : original(...args),
    );
    await expect(
      service.call("start", { sessionId: "session", modelId: "configured", text: "hello" }),
    ).rejects.toMatchObject({ code: "configurationRequired" });
    expect(call.mock.calls.some((args) => args[1] === "send_message")).toBe(false);
  });

  it("does not append a new Turn to a natively running Session", async () => {
    const { service, call } = setup();
    const original = call.getMockImplementation();
    if (!original) throw new Error("Missing native fixture implementation");
    call.mockImplementation(async (...args) =>
      args[1] === "get_chat_session"
        ? { chat_session_id: "session", local_project_id: "project", status: 3 }
        : original(...args),
    );
    await expect(
      service.call("start", { sessionId: "session", modelId: "configured", text: "hello" }),
    ).rejects.toMatchObject({ code: "sessionBusy" });
    expect(call.mock.calls.some((args) => args[1] === "send_message")).toBe(false);
  });

  it("distinguishes a fresh Pending Session from one with an already queued message", async () => {
    const { service, call } = setup();
    const original = call.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    let queued = false;
    call.mockImplementation(async (...args) =>
      args[1] === "get_chat_session"
        ? { chat_session_id: "session", local_project_id: "project", status: 1 }
        : args[1] === "get_messages"
          ? { items: queued ? [{ message_id: "queued" }] : [] }
          : original(...args),
    );
    await expect(
      service.call("start", { sessionId: "session", modelId: "configured", text: "first" }),
    ).resolves.toMatchObject({ accepted: true });
    queued = true;
    await expect(
      service.call("start", { sessionId: "session", modelId: "configured", text: "second" }),
    ).rejects.toMatchObject({ code: "sessionBusy" });
    expect(call.mock.calls.filter((args) => args[1] === "send_message")).toHaveLength(1);
  });

  it("serializes admission before asynchronous native status checks", async () => {
    const { service, call } = setup();
    const original = call.getMockImplementation();
    if (!original) throw new Error("Missing native fixture implementation");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    call.mockImplementation(async (...args) => {
      if (args[1] === "get_chat_session") await gate;
      return original(...args);
    });
    const first = service.call("start", {
      sessionId: "session",
      modelId: "configured",
      text: "first",
    });
    await expect(
      service.call("start", { sessionId: "session", modelId: "configured", text: "second" }),
    ).rejects.toMatchObject({ code: "sessionBusy" });
    release();
    await first;
    expect(call.mock.calls.filter((args) => args[1] === "send_message")).toHaveLength(1);
  });

  it("does not treat an unknown native status as an idle Session", async () => {
    const { service, call } = setup();
    const original = call.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    call.mockImplementation(async (...args) =>
      args[1] === "get_chat_session"
        ? { chat_session_id: "session", local_project_id: "project" }
        : original(...args),
    );
    await expect(
      service.call("start", { sessionId: "session", modelId: "configured", text: "hello" }),
    ).rejects.toMatchObject({ code: "protocolError" });
    expect(call.mock.calls.some((args) => args[1] === "send_message")).toBe(false);
  });
});

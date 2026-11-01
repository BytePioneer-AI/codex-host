import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const { forkNativeSession } = createRequire(import.meta.url)("../assets/companion/history.cjs");
function setup() {
  const source = {
    sessionId: "source",
    projectId: "project",
    status: 5,
    items: [
      { message_id: "user", role: "user" },
      {
        message_id: "assistant",
        reply_to_message_id: "user",
        role: "assistant",
        status: "completed",
      },
    ],
  };
  const service = {
    historySettings: vi.fn(async () => ({ forkFromMessage: true, forkFromSession: true })),
    call: vi.fn(async () => source),
    native: { call: vi.fn(async () => ({ new_session_id: "derived" })) },
    readSession: vi.fn(async () => ({ projectId: "project" })),
  };
  return { source, service };
}
describe("TRAE CN native history derivation", () => {
  it("forks an exact native assistant boundary and checks that the source is unchanged", async () => {
    const { service } = setup();
    await expect(
      forkNativeSession(service, { sessionId: "source", messageId: "assistant" }),
    ).resolves.toEqual({ sessionId: "derived", projectId: "project" });
    expect(service.native.call).toHaveBeenCalledExactlyOnceWith(
      "lite",
      "fork_session",
      { session_id: "source", project_id: "project", message_id: "assistant" },
      { project_id: "project", chat_session_id: "source" },
    );
    expect(service.call).toHaveBeenCalledTimes(2);
    expect(service.readSession).toHaveBeenCalledExactlyOnceWith("derived");
  });
  it("rejects disabled features, active sources and invalid boundaries before native writes", async () => {
    const disabled = setup();
    disabled.service.historySettings.mockResolvedValue({
      forkFromMessage: false,
      forkFromSession: false,
    });
    await expect(
      forkNativeSession(disabled.service, { sessionId: "source" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(disabled.service.call).not.toHaveBeenCalled();
    const busy = setup();
    busy.service.call.mockResolvedValue({ ...busy.source, status: 3 });
    await expect(forkNativeSession(busy.service, { sessionId: "source" })).rejects.toMatchObject({
      code: "sessionBusy",
    });
    expect(busy.service.native.call).not.toHaveBeenCalled();
    const invalid = setup();
    await expect(
      forkNativeSession(invalid.service, { sessionId: "source", messageId: "user" }),
    ).rejects.toMatchObject({ code: "checkpointNotFound" });
    expect(invalid.service.native.call).not.toHaveBeenCalled();
    const files = setup();
    files.service.call.mockResolvedValue({
      ...files.source,
      items: files.source.items.map((item) => ({ ...item, fileDiffs: [] })),
    });
    await expect(forkNativeSession(files.service, { sessionId: "source" })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(files.service.native.call).not.toHaveBeenCalled();
  });
  it("does not repeat an uncertain fork admission or hide the known child on validation failure", async () => {
    const uncertain = setup();
    uncertain.service.native.call.mockResolvedValue({ new_session_id: "" });
    await expect(forkNativeSession(uncertain.service, { sessionId: "source" })).rejects.toThrow(
      "uncertain",
    );
    expect(uncertain.service.native.call).toHaveBeenCalledOnce();
    const changed = setup();
    changed.service.call
      .mockResolvedValueOnce(changed.source)
      .mockResolvedValueOnce({ ...changed.source, items: [] });
    await expect(forkNativeSession(changed.service, { sessionId: "source" })).rejects.toThrow(
      "Derived Session derived was preserved",
    );
    expect(changed.service.native.call).toHaveBeenCalledOnce();
    const foreign = setup();
    foreign.service.readSession.mockResolvedValue({ projectId: "another-project" });
    await expect(forkNativeSession(foreign.service, { sessionId: "source" })).rejects.toThrow(
      "changed workspace Project",
    );
    expect(foreign.service.native.call).toHaveBeenCalledOnce();
  });
});

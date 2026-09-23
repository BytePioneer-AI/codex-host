import { createOpencodeClient as createMimoClient, type Part } from "@mimo-ai/sdk/v2/client";
import { describe, expect, it } from "vitest";
import { projectHistory, readMessages, type NativeMessage } from "../src/history.js";
import { assistant, FakeNative, textPart, user } from "./fixtures.js";

describe("MiMo native history", () => {
  it("uses the opaque native next cursor and reads beyond 1000 messages in stable order", async () => {
    const older: NativeMessage[] = [
      { info: user("msg_0000"), parts: [textPart("msg_0000", "old")] },
    ];
    const newer: NativeMessage[] = Array.from({ length: 1000 }, (_, index) => {
      const id = `msg_${String(index + 1).padStart(4, "0")}`;
      return { info: user(id), parts: [textPart(id, `input ${index}`)] };
    });
    const cursor = Buffer.from(JSON.stringify({ id: "msg_0001", time: 123 })).toString("base64url");
    const before: Array<string | null> = [];
    const client = createMimoClient({
      baseUrl: "http://127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        expect(url.searchParams.get("limit")).toBe("1000");
        before.push(url.searchParams.get("before"));
        return url.searchParams.has("before")
          ? Response.json(older)
          : Response.json(newer, { headers: { "X-Next-Cursor": cursor } });
      },
    });
    const messages = await readMessages(client, "ses_test");
    expect(messages).toHaveLength(1001);
    expect(messages[0]?.info.id).toBe("msg_0000");
    expect(before).toEqual([null, cursor]);
    expect(await readMessages(client, "ses_test")).toEqual(messages);
  });

  it("rejects repeated pagination and foreign part ownership rather than returning partial success", async () => {
    const message: NativeMessage = { info: user("msg_1"), parts: [textPart("msg_1", "text")] };
    const duplicate = createMimoClient({
      baseUrl: "http://127.0.0.1",
      fetch: async () => Response.json([message], { headers: { "X-Next-Cursor": "repeated" } }),
    });
    await expect(readMessages(duplicate, "ses_test")).rejects.toMatchObject({
      code: "protocolError",
    });
    const foreign = createMimoClient({
      baseUrl: "http://127.0.0.1",
      fetch: async () => Response.json([{ ...message, parts: [textPart("msg_foreign", "text")] }]),
    });
    await expect(readMessages(foreign, "ses_test")).rejects.toMatchObject({
      code: "protocolError",
    });
  });

  it("groups multi-step assistants by native user identity and keeps tool failures separate from turn result", () => {
    const info = assistant("msg_user", "msg_assistant");
    const tool: Part = {
      id: "prt_tool",
      sessionID: "ses_test",
      messageID: info.id,
      type: "tool",
      callID: "call",
      tool: "read",
      state: {
        status: "error",
        input: { path: "missing" },
        error: "missing",
        time: { start: 1, end: 2 },
      },
    };
    const final = assistant("msg_user", "msg_final");
    const messages: NativeMessage[] = [
      { info: user("msg_user"), parts: [textPart("msg_user", "read")] },
      {
        info: { ...info, time: { created: 2, completed: 3 }, finish: "tool-calls" },
        parts: [tool],
      },
      {
        info: { ...final, time: { created: 4, completed: 5 }, finish: "stop" },
        parts: [textPart(final.id, "Unavailable")],
      },
    ];
    const snapshot = projectHistory(new FakeNative().native, messages);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.outcome).toEqual({ status: "succeeded" });
    expect(snapshot.turns[0]?.items[0]?.outcome.status).toBe("failed");
    expect(projectHistory(new FakeNative().native, messages)).toEqual(snapshot);
    expect(
      projectHistory(new FakeNative().native, messages.slice(0, 2)).turns[0]?.outcome.status,
    ).toBe("unknown");
  });
});

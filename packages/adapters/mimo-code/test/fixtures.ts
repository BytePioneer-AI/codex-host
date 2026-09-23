import {
  createOpencodeClient as createMimoClient,
  type AssistantMessage,
  type Event,
  type Model,
  type Part,
  type Session,
  type UserMessage,
} from "@mimo-ai/sdk/v2/client";
import type { NativeMessage } from "../src/history.js";
import type { MimoConnection, ServerOptions } from "../src/server.js";

export function user(id: string, sessionID = "ses_test"): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    agent: "build",
    time: { created: 1 },
    model: { providerID: "mimo", modelID: "tiny" },
  };
}
export function assistant(
  parentID: string,
  id = "msg_reply",
  sessionID = "ses_test",
): AssistantMessage {
  return {
    id,
    sessionID,
    parentID,
    role: "assistant",
    agent: "build",
    mode: "build",
    modelID: "tiny",
    providerID: "mimo",
    time: { created: 2 },
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}
export function textPart(
  messageID: string,
  text: string,
  id = "prt_text",
  sessionID = "ses_test",
): Extract<Part, { type: "text" }> {
  return { id, messageID, sessionID, type: "text", text };
}
export const model: Model = {
  id: "tiny",
  providerID: "mimo",
  name: "Tiny",
  api: { id: "tiny", url: "http://127.0.0.1", npm: "native" },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 10000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
};

export class FakeNative {
  native: Session = {
    id: "ses_test",
    slug: "test",
    projectID: "project",
    directory: process.cwd(),
    title: "Test",
    version: "0.1.14",
    time: { created: 1, updated: 1 },
  };
  messages: NativeMessage[] = [];
  requests: Request[] = [];
  connections: ServerOptions[] = [];
  closes = 0;
  closeFailures = 0;
  autoAdmit = true;
  permissionConfirmed = true;
  authenticated = true;
  skipAll = false;
  autoApproveDelete = false;
  confirmUnattended = true;
  missing = false;
  stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  promptID = "";
  promptBody: Record<string, unknown> = {};
  finishRequest: ((response: Response) => void) | undefined;
  exit!: () => void;
  readonly exited = new Promise<void>((resolve) => {
    this.exit = resolve;
  });
  readonly client = createMimoClient({
    baseUrl: "http://127.0.0.1:3456",
    directory: process.cwd(),
    fetch: async (request) =>
      this.fetch(request instanceof Request ? request : new Request(request)),
  });
  readonly connect = async (options: ServerOptions): Promise<MimoConnection> => {
    this.connections.push(options);
    return {
      client: this.client,
      exited: this.exited,
      close: async () => {
        this.closes++;
        if (this.closeFailures > 0) {
          this.closeFailures--;
          throw new Error("Injected native cleanup rejection");
        }
        this.finishRequest?.(new Response("closed", { status: 503 }));
      },
    };
  };
  emit(event: Event): void {
    this.stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  }
  admit(): void {
    const info = user(this.promptID);
    const parts = (this.promptBody.parts as Array<{ text: string }>).map((part, index) =>
      textPart(info.id, part.text, `prt_input_${index}`),
    );
    this.messages.push({ info, parts });
    this.emit({ type: "message.updated", properties: { sessionID: info.sessionID, info } });
    this.emit({
      type: "session.status",
      properties: { sessionID: info.sessionID, status: { type: "busy" } },
    });
  }
  finish(info: AssistantMessage, parts: Part[]): void {
    this.messages.push({ info, parts });
    this.emit({ type: "message.updated", properties: { sessionID: info.sessionID, info } });
    for (const part of parts)
      this.emit({
        type: "message.part.updated",
        properties: { sessionID: part.sessionID, part, time: 3 },
      });
    this.finishRequest?.(Response.json({ info, parts }));
  }
  async fetch(request: Request): Promise<Response> {
    this.requests.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path === "/permission/skip-all" || path === "/permission/auto-approve-delete") {
      const key = path.endsWith("skip-all") ? "skipAll" : "autoApproveDelete";
      if (request.method === "POST") {
        const body = (await request.json()) as { enabled: boolean };
        if (this.confirmUnattended) this[key] = body.enabled;
      }
      return Response.json(this[key]);
    }
    if (path === "/event")
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.stream = controller;
            this.emit({ type: "server.connected", properties: {} });
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    if (path === "/provider")
      return Response.json({
        all: [
          {
            id: "mimo",
            name: "MiMo",
            source: "config",
            env: [],
            options: {},
            models: { tiny: model, other: { ...model, id: "other", name: "Other" } },
          },
        ],
        connected: ["mimo"],
        authenticated: this.authenticated ? ["mimo"] : [],
        default: { mimo: "tiny" },
      });
    if (path === "/session/status") return Response.json({});
    if (path === "/session" && request.method === "POST") {
      const body = JSON.parse((await request.text()) || "{}") as {
        permission?: Session["permission"];
      };
      if (body.permission) this.native.permission = body.permission;
      return Response.json(this.native);
    }
    if (path === "/session/ses_test") {
      if (this.missing) return Response.json({ name: "NotFoundError" }, { status: 404 });
      if (request.method === "PATCH") {
        const body = (await request.json()) as { permission: NonNullable<Session["permission"]> };
        if (this.permissionConfirmed) this.native.permission = body.permission;
      }
      return Response.json(this.native);
    }
    if (path === "/session/ses_test/message") {
      if (request.method === "GET") return Response.json(this.messages);
      this.promptBody = (await request.json()) as Record<string, unknown>;
      this.promptID = this.promptBody.messageID as string;
      if (this.autoAdmit) this.admit();
      return new Promise((resolve) => {
        this.finishRequest = resolve;
      });
    }
    if (path.endsWith("/abort") || path.endsWith("/reply") || path.endsWith("/reject"))
      return Response.json(true);
    throw new Error(`Unexpected native request ${request.method} ${path}`);
  }
}

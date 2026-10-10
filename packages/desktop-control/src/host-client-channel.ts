import { readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  clientChannelDescriptorSchema,
  clientChannelEventSchema,
  clientThreadSnapshotSchema,
  type ClientChannelDescriptor,
  type ClientChannelCursor,
  type ClientChannelEvent,
  type ClientChannelResponse,
  type ClientThreadSnapshot,
} from "@codexhost/shared-contracts";

export type HostClientUpdate = ClientChannelEvent | { type: "connection"; online: boolean };
export async function discoverHostClientChannel(
  directory: string,
): Promise<ClientChannelDescriptor | null> {
  const candidates: ClientChannelDescriptor[] = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/^host-\d+(?:-[0-9a-f-]+)?\.json$/u.test(name)) continue;
    try {
      const handle = await open(
        path.join(directory, name),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.size > 4096 ||
          (process.platform !== "win32" &&
            (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
        )
          continue;
        const descriptor = clientChannelDescriptorSchema.parse(
          JSON.parse(await handle.readFile("utf8")),
        );
        process.kill(descriptor.pid, 0);
        candidates.push(descriptor);
      } finally {
        await handle.close();
      }
    } catch {
      /* Dead, foreign, malformed or inaccessible endpoints are not owners. */
    }
  }
  return candidates.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/** Read-only reconnects and bounded invalidation replay. Mutations are never retried. */
export class HostClientChannel {
  private descriptor: ClientChannelDescriptor;
  private cursor: ClientChannelCursor | undefined;
  private history: Array<Extract<ClientChannelEvent, { type: "changed" }>> = [];
  private controller: AbortController | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<(update: HostClientUpdate) => void>();
  private stopped = false;
  private online = false;
  private generation = 0;
  private readonly ready = Promise.withResolvers<undefined>();
  private started = false;
  constructor(
    private readonly directory: string,
    descriptor: ClientChannelDescriptor,
  ) {
    this.descriptor = descriptor;
  }
  subscribe(listener: (update: HostClientUpdate) => void, after?: ClientChannelCursor): () => void {
    listener({ type: "connection", online: this.online });
    const cursor = this.cursor;
    if (this.online && cursor) {
      const oldest = this.history[0]?.cursor.sequence ?? cursor.sequence + 1;
      const replay =
        after?.epoch === cursor.epoch &&
        after.sequence >= oldest - 1 &&
        after.sequence <= cursor.sequence;
      listener({ type: "hello", version: 1, cursor, reset: !replay });
      if (replay)
        for (const event of this.history)
          if (event.cursor.sequence > after.sequence) listener(event);
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(update: HostClientUpdate) {
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
  start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      void this.connect();
    }
    return this.ready.promise;
  }
  private async connect(): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    this.generation++;
    let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(),
      5000,
    );
    try {
      const descriptor = await discoverHostClientChannel(this.directory);
      if (!descriptor) throw new Error("Host unavailable");
      this.descriptor = descriptor;
      const url = new URL(`http://127.0.0.1:${descriptor.port}/v1/events`);
      if (this.cursor) {
        url.searchParams.set("epoch", this.cursor.epoch);
        url.searchParams.set("after", String(this.cursor.sequence));
      }
      const response = await fetch(url, {
        redirect: "error",
        headers: { authorization: `Bearer ${descriptor.token}` },
        signal: controller.signal,
      });
      clearTimeout(deadline);
      deadline = setTimeout(() => controller.abort(), 45_000);
      if (!response.ok || !response.body) throw new Error("Host event channel refused");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Host event channel ended");
        clearTimeout(deadline);
        deadline = setTimeout(() => controller.abort(), 45_000);
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 256 * 1024) throw new Error("Host event frame exceeds limit");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          const event = clientChannelEventSchema.parse(JSON.parse(line));
          if (event.type === "hello") {
            if (event.cursor.epoch !== descriptor.epoch)
              throw new Error("Host descriptor generation changed");
            if (event.reset || !this.cursor) {
              this.cursor = event.cursor;
              this.history = [];
            }
            this.online = true;
            this.ready.resolve(undefined);
            this.publish({ type: "connection", online: true });
            this.publish(event);
          } else {
            if (
              !this.cursor ||
              event.cursor.epoch !== this.cursor.epoch ||
              event.cursor.sequence !== this.cursor.sequence + 1
            )
              throw new Error("Host event sequence gap");
            this.cursor = event.cursor;
            this.history.push(event);
            if (this.history.length > 512) this.history.shift();
            this.publish(event);
          }
        }
      }
    } catch {
      this.ready.reject(new Error("Host event connection unavailable"));
      if (!this.stopped) {
        this.online = false;
        this.publish({ type: "connection", online: false });
      }
    } finally {
      clearTimeout(deadline);
      controller.abort();
      if (!this.stopped) {
        this.retry = setTimeout(() => {
          void this.connect();
        }, 1000);
        this.retry.unref();
      }
    }
  }
  private async post<T>(route: string, body: unknown): Promise<T> {
    if (this.stopped || !this.online)
      throw new Error("CH is disconnected; reconnect before submitting an operation");
    let response: Response;
    let value: { result?: T; error?: { code?: number; message?: string } };
    try {
      response = await fetch(`http://127.0.0.1:${this.descriptor.port}${route}`, {
        redirect: "error",
        method: "POST",
        headers: {
          authorization: `Bearer ${this.descriptor.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Invalid Host reply");
      value = parsed as typeof value;
    } catch {
      throw Object.assign(
        new Error(
          "CH connection lost; operation outcome may be unknown. Do not retry automatically.",
        ),
        { code: -32093 },
      );
    }
    if (value.error || !response.ok)
      throw Object.assign(new Error(value.error?.message ?? "Host request failed"), {
        code: value.error?.code ?? -32603,
      });
    if (!Object.hasOwn(value, "result"))
      throw new Error("Invalid Host reply; operation outcome may be unknown");
    return value.result as T;
  }
  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.post("/v1/rpc", { method, params });
  }
  async snapshot(threadId: string): Promise<ClientThreadSnapshot> {
    const generation = this.generation;
    const snapshot = clientThreadSnapshotSchema.parse(
      await this.post("/v1/snapshot", { threadId }),
    );
    if (
      snapshot.thread.id !== threadId ||
      snapshot.interactions.some((request) => request.threadId !== threadId)
    )
      throw new Error("Host snapshot belongs to another Thread");
    if (
      generation !== this.generation ||
      !this.online ||
      snapshot.cursor.epoch !== this.descriptor.epoch
    )
      throw Object.assign(new Error("Obsolete Host snapshot; resynchronize after reconnecting"), {
        code: -32094,
      });
    return snapshot;
  }
  respond(input: ClientChannelResponse): Promise<{ resolved: boolean }> {
    return this.post("/v1/respond", input);
  }
  close(): void {
    this.stopped = true;
    this.online = false;
    clearTimeout(this.retry);
    this.controller?.abort();
    this.publish({ type: "connection", online: false });
    this.listeners.clear();
  }
}

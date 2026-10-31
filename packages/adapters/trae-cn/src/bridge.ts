import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { discoverBridges, sameDirectory, type BridgeOptions } from "./discovery.js";
import { record, responseError, TraeError } from "./errors.js";
import {
  readInspection,
  type BridgeEvent,
  type BridgeInspection,
  type Endpoint,
} from "./protocol.js";

const MAX_RESPONSE = 64 * 1024 * 1024;
const MAX_LINE = 16 * 1024 * 1024;

async function readJson(response: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const value = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : undefined;
    if (!value) throw new TraeError("protocolError", "Invalid bridge response bytes");
    size += value.length;
    if (size > MAX_RESPONSE)
      throw new TraeError("protocolError", "TRAE CN snapshot exceeds the transport limit");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TraeError("protocolError", "Invalid TRAE CN bridge response JSON");
  }
}

function unwrap(value: unknown): unknown {
  if (!record(value) || typeof value.ok !== "boolean")
    throw new TraeError("protocolError", "Invalid bridge response envelope");
  if (!value.ok) throw responseError(value.error);
  return value.value;
}

export interface BridgeListener {
  event(value: BridgeEvent): void;
  error(error: TraeError): void;
  end(): void;
}

/** Owner-private local HTTP. Requests never use proxy configuration or follow redirects. */
export class BridgeClient {
  #closed = false;
  #requests = new Set<http.ClientRequest>();
  #timeout: number;
  #endpoint: Endpoint;

  constructor(endpoint: Endpoint, timeoutMs = 35000) {
    this.#endpoint = endpoint;
    this.#timeout = timeoutMs;
  }

  static async connect(
    options: BridgeOptions,
  ): Promise<{ client: BridgeClient; inspection: BridgeInspection }> {
    const endpoints = await discoverBridges(options);
    let failure: TraeError | undefined;
    for (const endpoint of endpoints) {
      const client = new BridgeClient(endpoint, options.timeoutMs);
      try {
        const inspection = await client.inspect();
        if (!inspection.workspaceFolders.some((folder) => sameDirectory(folder, options.cwd)))
          throw new TraeError("configurationRequired", "The TRAE CN workspace changed");
        return { client, inspection };
      } catch (error) {
        client.close();
        failure =
          error instanceof TraeError
            ? error
            : new TraeError("unavailable", "TRAE CN Companion is unavailable");
      }
    }
    throw (
      failure ??
      new TraeError(
        "configurationRequired",
        "Open this workspace in TRAE CN with the CodexHost Companion enabled",
      )
    );
  }

  #request(endpoint: string, input: unknown): http.ClientRequest {
    if (this.#closed) throw new TraeError("invalidState", "TRAE CN bridge client is closed");
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 8 * 1024 * 1024)
      throw new TraeError("invalidRequest", "TRAE CN request exceeds the transport limit");
    const request = http.request({
      hostname: "127.0.0.1",
      port: this.#endpoint.port,
      path: endpoint,
      method: "POST",
      agent: false,
      headers: {
        host: `127.0.0.1:${this.#endpoint.port}`,
        authorization: `Bearer ${this.#endpoint.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    });
    this.#requests.add(request);
    request.end(body);
    return request;
  }

  async #post(endpoint: string, input: unknown): Promise<unknown> {
    const request = this.#request(endpoint, input);
    return new Promise((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(
        () =>
          request.destroy(
            new TraeError(
              "unavailable",
              "TRAE CN bridge request timed out; verify native state before retrying",
            ),
          ),
        this.#timeout,
      );
      const finish = (error?: unknown, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.#requests.delete(request);
        if (error)
          reject(
            error instanceof TraeError
              ? error
              : new TraeError("unavailable", "TRAE CN bridge connection failed"),
          );
        else resolve(value);
      };
      request.once("error", (error) => finish(error));
      request.once("response", (response) => {
        void readJson(response)
          .then((value) => {
            const result = unwrap(value);
            if (response.statusCode !== 200)
              throw new TraeError("protocolError", "Unexpected TRAE CN HTTP status");
            finish(undefined, result);
          })
          .catch((error: unknown) => finish(error));
      });
    });
  }

  async inspect(refresh = false): Promise<BridgeInspection> {
    const inspection = readInspection(await this.#post("/inspect", { refresh }));
    if (
      inspection.instanceId !== this.#endpoint.instanceId ||
      !sameDirectory(inspection.application.root, this.#endpoint.application.root)
    )
      throw new TraeError("protocolError", "The TRAE CN Companion instance changed");
    return inspection;
  }

  call(method: string, input: Record<string, unknown> = {}): Promise<unknown> {
    return this.#post("/call", { method, input });
  }

  subscribe(
    input: { sessionId: string; lastEventId?: string },
    listener: BridgeListener,
  ): Promise<() => void> {
    const request = this.#request("/subscribe", input);
    return new Promise((resolve, reject) => {
      let headers = false;
      let finished = false;
      let pending = "";
      const decoder = new StringDecoder("utf8");
      const timer = setTimeout(
        () => request.destroy(new TraeError("unavailable", "TRAE CN subscription timed out")),
        this.#timeout,
      );
      const cleanup = () => {
        clearTimeout(timer);
        this.#requests.delete(request);
      };
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        const failure =
          error instanceof TraeError
            ? error
            : new TraeError("unavailable", "TRAE CN event connection failed");
        request.destroy();
        if (headers) listener.error(failure);
        else reject(failure);
      };
      const cancel = () => {
        if (finished) return;
        finished = true;
        cleanup();
        request.destroy();
      };
      const line = (source: string) => {
        const value: unknown = JSON.parse(source);
        if (!record(value)) throw new TraeError("protocolError", "Invalid bridge stream frame");
        if (value.type === "event") {
          if (!record(value.value) || typeof value.value.event !== "string")
            throw new TraeError("protocolError", "Invalid TRAE CN event");
          listener.event({
            event: value.value.event,
            ...(typeof value.value.id === "string" ? { id: value.value.id } : {}),
            ...(value.value.payload !== undefined ? { payload: value.value.payload } : {}),
          });
        } else if (value.type === "end") {
          finished = true;
          cleanup();
          request.destroy();
          listener.end();
        } else if (value.type === "error") fail(responseError(value.error));
        else throw new TraeError("protocolError", "Unknown bridge stream frame");
      };
      request.once("error", fail);
      request.once("response", (response) => {
        if (
          response.statusCode !== 200 ||
          !response.headers["content-type"]?.startsWith("application/x-ndjson")
        ) {
          void readJson(response)
            .then((value) => {
              unwrap(value);
              throw new TraeError("protocolError", "Invalid bridge stream response");
            })
            .catch(fail);
          return;
        }
        headers = true;
        clearTimeout(timer);
        response.on("error", fail);
        response.on("data", (chunk: Buffer) => {
          if (finished) return;
          try {
            pending += decoder.write(chunk);
            let index: number;
            while (!finished && (index = pending.indexOf("\n")) >= 0) {
              const complete = pending.slice(0, index);
              pending = pending.slice(index + 1);
              if (complete.length > MAX_LINE)
                throw new TraeError("protocolError", "TRAE CN event exceeds the transport limit");
              if (complete.trim()) line(complete);
            }
            if (pending.length > MAX_LINE)
              throw new TraeError("protocolError", "TRAE CN event exceeds the transport limit");
          } catch (error) {
            fail(error);
          }
        });
        response.once("end", () => {
          if (!finished)
            fail(new TraeError("protocolError", "TRAE CN stream closed without a terminal frame"));
        });
        resolve(cancel);
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const request of this.#requests)
      request.destroy(new TraeError("invalidState", "TRAE CN bridge client closed"));
    this.#requests.clear();
  }
}

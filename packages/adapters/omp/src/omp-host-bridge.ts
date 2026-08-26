import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";

export type OmpHostToolLoadMode = "essential" | "discoverable";

export interface OmpHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: JsonObject;
  hidden?: boolean;
  loadMode?: OmpHostToolLoadMode;
}

export type OmpHostToolContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface OmpHostToolResult {
  content: OmpHostToolContent[];
  details?: JsonValue;
  isError?: boolean;
  useless?: boolean;
}

export interface OmpHostToolCall {
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: JsonObject;
}

export type OmpHostToolUpdate = (result: OmpHostToolResult) => void;

export interface OmpHostToolRegistration extends OmpHostToolDefinition {
  execute(
    call: OmpHostToolCall,
    signal: AbortSignal,
    onUpdate: OmpHostToolUpdate,
  ): Promise<OmpHostToolResult>;
}

export interface OmpHostUriSchemeDefinition {
  scheme: string;
  description?: string;
  writable?: boolean;
  immutable?: boolean;
}

export type OmpHostUriContentType = "text/markdown" | "application/json" | "text/plain";

export interface OmpHostUriResult {
  content?: string;
  contentType?: OmpHostUriContentType;
  notes?: string[];
  immutable?: boolean;
  isError?: boolean;
  error?: string;
}

export interface OmpHostUriRequest {
  id: string;
  operation: "read" | "write";
  url: string;
  content?: string;
}

export interface OmpHostUriRegistration extends OmpHostUriSchemeDefinition {
  resolve(request: OmpHostUriRequest, signal: AbortSignal): Promise<OmpHostUriResult>;
}

interface PendingRequest {
  controller: AbortController;
  cancelled: boolean;
}

interface OmpHostBridgeOptions {
  send(frame: Record<string, unknown>): Promise<void>;
  onFailure(error: Error): void;
  tools?: readonly OmpHostToolRegistration[];
  uriSchemes?: readonly OmpHostUriRegistration[];
}

const HOST_URI_SCHEME = /^[a-z][a-z0-9+.-]*$/;
const RESERVED_URI_SCHEMES = new Set(["security"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeToolResult(value: unknown): OmpHostToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OMP Host Tool returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.content)) {
    throw new Error("OMP Host Tool result has no content array");
  }
  const content = result.content.map((item): OmpHostToolContent => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("OMP Host Tool result contains an invalid content block");
    }
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string" &&
      block.mimeType.length > 0
    ) {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    throw new Error("OMP Host Tool result contains an invalid content block");
  });
  const details =
    result.details === undefined ? undefined : jsonValueSchema.safeParse(result.details);
  if (details !== undefined && !details.success) {
    throw new Error("OMP Host Tool result details are not JSON serializable");
  }
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new Error("OMP Host Tool result isError must be boolean");
  }
  if (result.useless !== undefined && typeof result.useless !== "boolean") {
    throw new Error("OMP Host Tool result useless must be boolean");
  }
  return {
    content,
    ...(details?.success ? { details: details.data } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(result.useless === true ? { useless: true } : {}),
  };
}

function toolDefinition(tool: OmpHostToolRegistration): JsonObject {
  return {
    name: tool.name,
    ...(tool.label !== undefined ? { label: tool.label } : {}),
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.hidden !== undefined ? { hidden: tool.hidden } : {}),
    ...(tool.loadMode !== undefined ? { loadMode: tool.loadMode } : {}),
  };
}

function normalizeUriResult(value: unknown): OmpHostUriResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OMP Host URI handler returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  if (result.content !== undefined && typeof result.content !== "string") {
    throw new Error("OMP Host URI result content must be a string");
  }
  if (
    result.contentType !== undefined &&
    result.contentType !== "text/markdown" &&
    result.contentType !== "application/json" &&
    result.contentType !== "text/plain"
  ) {
    throw new Error("OMP Host URI result contentType is invalid");
  }
  if (
    result.notes !== undefined &&
    (!Array.isArray(result.notes) || !result.notes.every((note) => typeof note === "string"))
  ) {
    throw new Error("OMP Host URI result notes are invalid");
  }
  for (const key of ["immutable", "isError"] as const) {
    if (result[key] !== undefined && typeof result[key] !== "boolean") {
      throw new Error(`OMP Host URI result ${key} must be boolean`);
    }
  }
  if (result.error !== undefined && typeof result.error !== "string") {
    throw new Error("OMP Host URI result error must be a string");
  }
  return {
    ...(typeof result.content === "string" ? { content: result.content } : {}),
    ...(result.contentType !== undefined
      ? { contentType: result.contentType as OmpHostUriContentType }
      : {}),
    ...(Array.isArray(result.notes) ? { notes: result.notes as string[] } : {}),
    ...(result.immutable === true ? { immutable: true } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(typeof result.error === "string" ? { error: result.error } : {}),
  };
}

function normalizeUriScheme(registration: OmpHostUriRegistration): OmpHostUriRegistration {
  const scheme = registration.scheme.trim().toLowerCase();
  if (!HOST_URI_SCHEME.test(scheme)) {
    throw new Error(`OMP Host URI scheme contains invalid characters: ${registration.scheme}`);
  }
  if (RESERVED_URI_SCHEMES.has(scheme)) {
    throw new Error(`OMP Host URI scheme is reserved: ${scheme}`);
  }
  return { ...registration, scheme };
}

export class OmpHostBridge {
  readonly #send: (frame: Record<string, unknown>) => Promise<void>;
  readonly #onFailure: (error: Error) => void;
  readonly #tools: Map<string, OmpHostToolRegistration>;
  readonly #uriSchemes: Map<string, OmpHostUriRegistration>;
  readonly #pendingTools = new Map<string, PendingRequest>();
  readonly #pendingUris = new Map<string, PendingRequest>();
  #closed = false;

  constructor(options: OmpHostBridgeOptions) {
    this.#send = options.send;
    this.#onFailure = options.onFailure;
    this.#tools = new Map();
    for (const tool of options.tools ?? []) {
      if (!nonBlankString(tool.name) || !nonBlankString(tool.description)) {
        throw new Error("OMP Host Tool requires a name and description");
      }
      if (this.#tools.has(tool.name)) {
        throw new Error(`OMP Host Tool is registered more than once: ${tool.name}`);
      }
      const parameters = jsonObjectSchema.safeParse(tool.parameters);
      if (!parameters.success) {
        throw new Error(`OMP Host Tool parameters are not a JSON object: ${tool.name}`);
      }
      this.#tools.set(tool.name, { ...tool, parameters: parameters.data });
    }
    this.#uriSchemes = new Map();
    for (const raw of options.uriSchemes ?? []) {
      const scheme = normalizeUriScheme(raw);
      if (this.#uriSchemes.has(scheme.scheme)) {
        throw new Error(`OMP Host URI scheme is registered more than once: ${scheme.scheme}`);
      }
      this.#uriSchemes.set(scheme.scheme, scheme);
    }
  }

  get hasToolConfiguration(): boolean {
    return this.#tools.size > 0;
  }

  get hasUriConfiguration(): boolean {
    return this.#uriSchemes.size > 0;
  }

  toolDefinitions(): JsonObject[] {
    return [...this.#tools.values()].map(toolDefinition);
  }

  uriSchemeDefinitions(): JsonObject[] {
    return [...this.#uriSchemes.values()].map((scheme) => ({
      scheme: scheme.scheme,
      ...(scheme.description !== undefined ? { description: scheme.description } : {}),
      ...(scheme.writable === true ? { writable: true } : {}),
      ...(scheme.immutable === true ? { immutable: true } : {}),
    }));
  }

  handleFrame(value: Record<string, unknown>): boolean {
    if (value.type === "host_tool_call") {
      this.#handleToolCall(value);
      return true;
    }
    if (value.type === "host_tool_cancel") {
      this.#handleToolCancel(value);
      return true;
    }
    if (value.type === "host_uri_request") {
      this.#handleUriRequest(value);
      return true;
    }
    if (value.type === "host_uri_cancel") {
      this.#handleUriCancel(value);
      return true;
    }
    return false;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of [...this.#pendingTools.values(), ...this.#pendingUris.values()]) {
      pending.cancelled = true;
      pending.controller.abort();
    }
    this.#pendingTools.clear();
    this.#pendingUris.clear();
  }

  #handleToolCall(value: Record<string, unknown>): void {
    const id = value.id;
    const toolCallId = value.toolCallId;
    const toolName = value.toolName;
    const argumentsResult = jsonObjectSchema.safeParse(value.arguments);
    if (
      !nonBlankString(id) ||
      !nonBlankString(toolCallId) ||
      !nonBlankString(toolName) ||
      !argumentsResult.success ||
      this.#pendingTools.has(id)
    ) {
      throw new Error("OMP Host Tool call is invalid");
    }
    const pending: PendingRequest = { controller: new AbortController(), cancelled: false };
    this.#pendingTools.set(id, pending);
    const tool = this.#tools.get(toolName);
    void this.#executeTool(id, pending, tool, {
      id,
      toolCallId,
      toolName,
      arguments: argumentsResult.data,
    });
  }

  async #executeTool(
    id: string,
    pending: PendingRequest,
    tool: OmpHostToolRegistration | undefined,
    call: OmpHostToolCall,
  ): Promise<void> {
    try {
      const result = tool
        ? await tool.execute(call, pending.controller.signal, (partialResult) => {
            const normalized = normalizeToolResult(partialResult);
            if (pending.cancelled || this.#closed) return;
            void this.#send({ type: "host_tool_update", id, partialResult: normalized }).catch(
              (error) => {
                this.#onFailure(error instanceof Error ? error : new Error(errorMessage(error)));
              },
            );
          })
        : {
            content: [
              { type: "text" as const, text: `OMP Host Tool is unavailable: ${call.toolName}` },
            ],
            isError: true,
          };
      const normalized = normalizeToolResult(result);
      if (!pending.cancelled && !this.#closed) {
        await this.#send({
          type: "host_tool_result",
          id,
          result: normalized,
          ...(normalized.isError === true ? { isError: true } : {}),
        });
      }
    } catch (error) {
      if (pending.cancelled || this.#closed) return;
      try {
        await this.#send({
          type: "host_tool_result",
          id,
          result: {
            content: [{ type: "text", text: errorMessage(error) }],
            isError: true,
          },
          isError: true,
        });
      } catch (sendError) {
        this.#onFailure(
          sendError instanceof Error ? sendError : new Error(errorMessage(sendError)),
        );
      }
    } finally {
      this.#pendingTools.delete(id);
    }
  }

  #handleToolCancel(value: Record<string, unknown>): void {
    if (!nonBlankString(value.id) || !nonBlankString(value.targetId)) {
      throw new Error("OMP Host Tool cancel is invalid");
    }
    const pending = this.#pendingTools.get(value.targetId);
    if (!pending) return;
    pending.cancelled = true;
    pending.controller.abort();
  }

  #handleUriRequest(value: Record<string, unknown>): void {
    const id = value.id;
    const operation = value.operation;
    const url = value.url;
    if (
      !nonBlankString(id) ||
      (operation !== "read" && operation !== "write") ||
      !nonBlankString(url) ||
      (value.content !== undefined && typeof value.content !== "string") ||
      this.#pendingUris.has(id)
    ) {
      throw new Error("OMP Host URI request is invalid");
    }
    const pending: PendingRequest = { controller: new AbortController(), cancelled: false };
    this.#pendingUris.set(id, pending);
    void this.#executeUri(id, pending, {
      id,
      operation,
      url,
      ...(typeof value.content === "string" ? { content: value.content } : {}),
    });
  }

  async #executeUri(
    id: string,
    pending: PendingRequest,
    request: OmpHostUriRequest,
  ): Promise<void> {
    const separator = request.url.indexOf(":");
    const scheme = separator > 0 ? request.url.slice(0, separator).toLowerCase() : "";
    const registration = this.#uriSchemes.get(scheme);
    try {
      let result: OmpHostUriResult;
      if (!registration) {
        result = { isError: true, error: `OMP Host URI scheme is unavailable: ${scheme}` };
      } else if (request.operation === "write" && registration.writable !== true) {
        result = { isError: true, error: `OMP Host URI scheme is read-only: ${scheme}` };
      } else {
        result = normalizeUriResult(await registration.resolve(request, pending.controller.signal));
      }
      if (!pending.cancelled && !this.#closed) {
        await this.#send({ type: "host_uri_result", id, ...result });
      }
    } catch (error) {
      if (pending.cancelled || this.#closed) return;
      try {
        await this.#send({
          type: "host_uri_result",
          id,
          isError: true,
          error: errorMessage(error),
        });
      } catch (sendError) {
        this.#onFailure(
          sendError instanceof Error ? sendError : new Error(errorMessage(sendError)),
        );
      }
    } finally {
      this.#pendingUris.delete(id);
    }
  }

  #handleUriCancel(value: Record<string, unknown>): void {
    if (!nonBlankString(value.id) || !nonBlankString(value.targetId)) {
      throw new Error("OMP Host URI cancel is invalid");
    }
    const pending = this.#pendingUris.get(value.targetId);
    if (!pending) return;
    pending.cancelled = true;
    pending.controller.abort();
  }
}

import type { InitializeResponse } from "@agentclientprotocol/sdk";

import {
  AntigravityTransportError,
  type AntigravityAcpConfigOption,
  type AntigravityAcpEvent,
  type AntigravityAcpSessionOpenResult,
  type AntigravityAcpTransportLike,
  type AntigravityAcpTransportOptions,
  type AntigravityActivePromptHandler,
  type AntigravityOpenAcpSessionInput,
  type AntigravityPromptInputPart,
  type AntigravityPromptResult,
  type AntigravitySessionEventHandler,
} from "./acp-types.js";

export class AntigravityAcpTransport implements AntigravityAcpTransportLike {
  readonly skipPermissions: boolean;

  constructor(options: AntigravityAcpTransportOptions) {
    this.skipPermissions = options.skipPermissions === true;
  }

  get sessionId(): string | null {
    return null;
  }

  get isClosed(): boolean {
    return false;
  }

  setSessionEventHandler(_handler: AntigravitySessionEventHandler | null): void {
    throw new AntigravityTransportError("unavailable", "AntigravityAcpTransport stub");
  }

  async initialize(): Promise<InitializeResponse> {
    throw new AntigravityTransportError("unavailable", "AntigravityAcpTransport stub");
  }

  async openSession(_input: AntigravityOpenAcpSessionInput): Promise<{
    opened: AntigravityAcpSessionOpenResult;
    replayedEvents: AntigravityAcpEvent[];
  }> {
    throw new AntigravityTransportError("unavailable", "AntigravityAcpTransport stub");
  }

  async setMode(_modeId: string): Promise<void> {
    throw new AntigravityTransportError("unavailable", "AntigravityAcpTransport stub");
  }

  async setConfigOption(_configId: string, _value: string): Promise<AntigravityAcpConfigOption[]> {
    throw new AntigravityTransportError("unavailable", "AntigravityAcpTransport stub");
  }

  async prompt(
    _parts: readonly AntigravityPromptInputPart[],
    _handler: AntigravityActivePromptHandler,
  ): Promise<AntigravityPromptResult> {
    throw new AntigravityTransportError("unavailable", "AntigravityAcpTransport stub");
  }

  async cancel(): Promise<void> {
    throw new AntigravityTransportError("unavailable", "AntigravityAcpTransport stub");
  }

  async closeSession(): Promise<void> {
    throw new AntigravityTransportError("unavailable", "AntigravityAcpTransport stub");
  }

  async close(): Promise<void> {}
}

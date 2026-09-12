import type {
  CanUseTool,
  CanUseToolOptions,
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ModelInfo as QoderModelInfo,
  Options as QoderOptions,
  PermissionMode as QoderPermissionMode,
  PermissionResult,
  Query as SdkQuery,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKSystemMessage,
  SDKUserMessage,
  SessionMessage,
} from "@qoder-ai/qoder-agent-sdk";

export type CanUseToolContext = CanUseToolOptions;

export type {
  CanUseTool,
  CanUseToolOptions,
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  QoderModelInfo,
  QoderOptions,
  QoderPermissionMode,
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKSystemMessage,
  SDKUserMessage,
  SdkQuery,
  SessionMessage,
};

export interface QoderContextUsage {
  contextWindow?: {
    usedPercentage?: number;
    totalTokens?: number;
    maxTokens?: number;
  };
  totalTokens?: number;
  maxTokens?: number;
}

export interface QoderQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void | Promise<void>;
  getAvailableModels?(options?: {
    fetchStrategy?: "live" | "cache";
    uid?: string;
  }): Promise<QoderModelInfo[]>;
  getContextUsage?(): Promise<unknown>;
  getUsageInfo?(): Promise<unknown>;
  setModel?(model?: string): Promise<void>;
  setPermissionMode?(mode: QoderPermissionMode): Promise<void>;
}

export type QoderQueryFactory = (input: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: QoderOptions;
}) => QoderQuery;

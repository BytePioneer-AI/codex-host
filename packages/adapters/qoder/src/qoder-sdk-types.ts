export interface SDKUserContentText {
  type: "text";
  text: string;
}

export interface SDKUserContentImage {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface SDKUserContentToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
}

export type SDKUserContent =
  | SDKUserContentText
  | SDKUserContentImage
  | SDKUserContentToolResult;

export interface SDKUserMessage {
  type: "user";
  uuid?: string;
  session_id?: string;
  priority?: "now" | "next" | "later";
  shouldQuery?: boolean;
  timestamp?: string;
  parent_tool_use_id: string | null;
  custom_context?: Record<string, string>;
  message: {
    role: "user";
    content: SDKUserContent[];
  };
  isSynthetic?: boolean;
  tool_use_result?: unknown;
}

export interface SDKAssistantContentText {
  type: "text";
  text: string;
}

export interface SDKAssistantContentThinking {
  type: "thinking";
  thinking: string;
}

export interface SDKAssistantContentToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type SDKAssistantContent =
  | SDKAssistantContentText
  | SDKAssistantContentThinking
  | SDKAssistantContentToolUse;

export interface SDKAssistantMessage {
  type: "assistant";
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  request_id?: string;
  message: {
    role: "assistant";
    content: SDKAssistantContent[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      credits?: number;
      original_credits?: number;
      billable?: boolean;
    };
  };
}

export interface SDKStreamEvent {
  type: "stream_event";
  uuid?: string;
  session_id?: string;
  event?: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
  };
  text_delta?: string;
  thinking_delta?: string;
  input_json_delta?: string;
}

export interface SDKResultMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | string;
  uuid?: string;
  session_id?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  result?: unknown;
  total_credits?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, { costUSD?: number; inputTokens?: number; outputTokens?: number }>;
  permission_denials?: unknown[];
  error_code?: number;
  errors?: string[];
}

export interface SDKSystemMessage {
  type: "system";
  subtype?: string;
  session_id?: string;
  qodercli_version?: string;
  protocol_version?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools?: string[];
  capabilities?: Record<string, unknown>;
  apiKeySource?: string;
  [key: string]: unknown;
}

export interface SDKGenericMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export type SDKMessage =
  | SDKSystemMessage
  | SDKAssistantMessage
  | SDKStreamEvent
  | SDKResultMessage
  | SDKGenericMessage;

export interface CanUseToolContext {
  signal: AbortSignal;
  toolUseID?: string;
}

export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: unknown;
      updatedPermissions?: unknown;
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

export type CanUseTool = (
  toolName: string,
  input: unknown,
  context: CanUseToolContext,
) => Promise<PermissionResult>;

export interface QoderOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  resume?: string;
  continue?: boolean;
  canUseTool?: CanUseTool;
  pathToQoderCLIExecutable?: string;
  includePartialMessages?: boolean;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  [key: string]: unknown;
}

export interface QoderModelInfo {
  value: string;
  displayName?: string;
  description?: string;
  supportsAutoMode?: boolean;
}

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
  interrupt(): Promise<void>;
  close(): void | Promise<void>;
  getAvailableModels?(): Promise<QoderModelInfo[]>;
  getContextUsage?(): Promise<QoderContextUsage>;
  setModel?(model: string): Promise<void>;
}

export type QoderQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: QoderOptions;
}) => QoderQuery;

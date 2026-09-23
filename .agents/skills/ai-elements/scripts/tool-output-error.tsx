/*
 * Derived from vercel/ai-elements (skills/ai-elements/scripts/tool-output-error.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * Adapted by codexhost: attribution pointer updated; see ../../NOTICE.md for license and provenance.
 */
"use client";

import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import type { ToolUIPart } from "ai";

const toolCall: ToolUIPart = {
  errorText:
    "Connection timeout: The request took longer than 5000ms to complete. Please check your network connection and try again.",
  input: {
    headers: {
      Authorization: "Bearer token123",
      "Content-Type": "application/json",
    },
    method: "GET",
    timeout: 5000,
    url: "https://api.example.com/data",
  },
  output: undefined,
  state: "output-error" as const,
  toolCallId: "api_request_1",
  type: "tool-api_request" as const,
};

const Example = () => (
  <div style={{ height: "500px" }}>
    <Tool>
      <ToolHeader state={toolCall.state} type={toolCall.type} />
      <ToolContent>
        <ToolInput input={toolCall.input} />
        {toolCall.state === "output-error" && (
          <ToolOutput errorText={toolCall.errorText} output={toolCall.output} />
        )}
      </ToolContent>
    </Tool>
  </div>
);

export default Example;

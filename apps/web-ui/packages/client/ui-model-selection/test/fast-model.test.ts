import type { ModelProviderGroup } from "@deepseek-ai/dsh-api-session-controller/types";
import { describe, expect, it } from "vitest";
import { modelRowSelection } from "../src/client/fast-model.ts";

const groups: readonly ModelProviderGroup[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    models: [
      {
        id: "opus",
        name: "Opus",
        reasoning: {
          efforts: [
            { id: "off", name: "Off" },
            { id: "auto", name: "Auto" },
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium" },
            { id: "high", name: "High" },
            { id: "xhigh", name: "Extra High" },
            { id: "max", name: "Max" },
          ],
          defaultEffort: "auto",
        },
      },
      {
        id: "sonnet",
        name: "Sonnet",
        reasoning: {
          efforts: [
            { id: "off", name: "Off" },
            { id: "auto", name: "Auto" },
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium" },
            { id: "high", name: "High" },
          ],
          defaultEffort: "auto",
        },
      },
      {
        id: "haiku",
        name: "Haiku",
        reasoning: {
          efforts: [
            { id: "off", name: "Off" },
            { id: "auto", name: "Auto" },
          ],
          defaultEffort: "auto",
        },
      },
    ],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    models: [
      {
        id: "gemini-4-neon",
        name: "Gemini 4 Neon",
        reasoning: {
          efforts: [
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium" },
            { id: "high", name: "High" },
            { id: "xhigh", name: "XHigh" },
          ],
          defaultEffort: "xhigh",
        },
      },
      {
        id: "gemini-4-hydrogen",
        name: "Gemini 4 Hydrogen",
        reasoning: {
          efforts: [
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium" },
            { id: "high", name: "High" },
            { id: "xhigh", name: "XHigh" },
          ],
          defaultEffort: "xhigh",
        },
      },
      {
        id: "gemini-4-carbon",
        name: "Gemini 4 Carbon",
        reasoning: {
          efforts: [
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium" },
            { id: "high", name: "High" },
          ],
        },
      },
      {
        id: "gemini-pro-orchestrator-neon",
        name: "Orchestrator (Neon)",
      },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    models: [
      {
        id: "gpt-5.6",
        name: "GPT-5.6",
        fastModel: "gpt-5.6-fast",
        ultrafastModel: "gpt-5.6-ultrafast",
        reasoning: {
          efforts: [
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium" },
            { id: "high", name: "High" },
          ],
          defaultEffort: "medium",
        },
      },
      {
        id: "gpt-5.6-ultrafast",
        name: "GPT-5.6 Ultrafast",
        reasoning: {
          efforts: [
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium" },
          ],
          defaultEffort: "medium",
        },
      },
    ],
  },
];

describe("modelRowSelection", () => {
  it("preserves the current thinking effort when switching to another model in the same Harness that supports it", () => {
    // Composer ModelSelect passes { provider, model } without reasoningEffort.
    expect(
      modelRowSelection(
        groups,
        { provider: "claude-code", model: "opus", reasoningEffort: "high" },
        { provider: "claude-code", model: "sonnet" },
      ),
    ).toEqual({
      provider: "claude-code",
      model: "sonnet",
      reasoningEffort: "high",
    });

    // /model popup passes the target model's defaultEffort ("auto"); current effort must still win.
    expect(
      modelRowSelection(
        groups,
        { provider: "claude-code", model: "opus", reasoningEffort: "high" },
        { provider: "claude-code", model: "sonnet", reasoningEffort: "auto" },
      ),
    ).toEqual({
      provider: "claude-code",
      model: "sonnet",
      reasoningEffort: "high",
    });

    // Antigravity switching between models keeps a non-default effort (e.g. low -> hydrogen / carbon).
    expect(
      modelRowSelection(
        groups,
        { provider: "antigravity", model: "gemini-4-neon", reasoningEffort: "low" },
        { provider: "antigravity", model: "gemini-4-hydrogen" },
      ),
    ).toEqual({
      provider: "antigravity",
      model: "gemini-4-hydrogen",
      reasoningEffort: "low",
    });

    expect(
      modelRowSelection(
        groups,
        { provider: "antigravity", model: "gemini-4-neon", reasoningEffort: "high" },
        { provider: "antigravity", model: "gemini-4-carbon" },
      ),
    ).toEqual({
      provider: "antigravity",
      model: "gemini-4-carbon",
      reasoningEffort: "high",
    });
  });

  it("drops reasoningEffort when switching to a model that does not support the current effort", () => {
    expect(
      modelRowSelection(
        groups,
        { provider: "claude-code", model: "opus", reasoningEffort: "xhigh" },
        { provider: "claude-code", model: "haiku", reasoningEffort: "auto" },
      ),
    ).toEqual({
      provider: "claude-code",
      model: "haiku",
    });

    expect(
      modelRowSelection(
        groups,
        { provider: "antigravity", model: "gemini-4-neon", reasoningEffort: "xhigh" },
        { provider: "antigravity", model: "gemini-4-carbon" },
      ),
    ).toEqual({
      provider: "antigravity",
      model: "gemini-4-carbon",
    });

    expect(
      modelRowSelection(
        groups,
        { provider: "antigravity", model: "gemini-4-neon", reasoningEffort: "high" },
        { provider: "antigravity", model: "gemini-pro-orchestrator-neon" },
      ),
    ).toEqual({
      provider: "antigravity",
      model: "gemini-pro-orchestrator-neon",
    });
  });

  it("retains Fast route and checks Ultrafast effort support within the same model family", () => {
    // Clicking the base row while on Fast keeps the Fast variant and effort.
    expect(
      modelRowSelection(
        groups,
        { provider: "codex", model: "gpt-5.6-fast", reasoningEffort: "high" },
        { provider: "codex", model: "gpt-5.6", reasoningEffort: "medium" },
      ),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.6-fast",
      reasoningEffort: "high",
    });

    // Switching to Ultrafast keeps supported effort and drops unsupported effort.
    expect(
      modelRowSelection(
        groups,
        { provider: "codex", model: "gpt-5.6", reasoningEffort: "low" },
        { provider: "codex", model: "gpt-5.6-ultrafast" },
      ),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.6-ultrafast",
      reasoningEffort: "low",
    });

    expect(
      modelRowSelection(
        groups,
        { provider: "codex", model: "gpt-5.6", reasoningEffort: "high" },
        { provider: "codex", model: "gpt-5.6-ultrafast" },
      ),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.6-ultrafast",
    });
  });

  it("returns the incoming selection unchanged when current is absent or belongs to another provider", () => {
    expect(
      modelRowSelection(groups, null, {
        provider: "claude-code",
        model: "opus",
        reasoningEffort: "auto",
      }),
    ).toEqual({
      provider: "claude-code",
      model: "opus",
      reasoningEffort: "auto",
    });

    expect(
      modelRowSelection(
        groups,
        { provider: "antigravity", model: "gemini-4-neon", reasoningEffort: "high" },
        { provider: "claude-code", model: "opus", reasoningEffort: "auto" },
      ),
    ).toEqual({
      provider: "claude-code",
      model: "opus",
      reasoningEffort: "auto",
    });
  });
});

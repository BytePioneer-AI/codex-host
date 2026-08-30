import { describe, expect, it } from "vitest";

import type { HarnessCommandDescriptor } from "@codexhost/shared-contracts";

import {
  rendererHarnessCommandPresentation,
  rendererHarnessMessages,
} from "../src/renderer-harness-localization.js";

const compactCommand = {
  id: "pi.compact",
  invocation: "/compact",
  label: "Compact context",
  description: "Compact the current conversation context",
  argumentMode: "text",
} as HarnessCommandDescriptor;

const customCommand = {
  id: "custom.explain",
  invocation: "/explain",
  label: "Explain",
  description: "Explain the current change",
  argumentMode: "none",
} as HarnessCommandDescriptor;

describe("Renderer Harness command localization", () => {
  it("uses Chinese chrome and compact copy for the Chinese settings locale", () => {
    expect(rendererHarnessMessages("zh-CN")).toMatchObject({
      commands: "命令",
      harnessCommands: "Harness 命令",
      textArgument: "文本",
    });
    expect(rendererHarnessCommandPresentation(compactCommand, "zh-CN")).toEqual({
      label: "压缩上下文",
      description: "压缩当前对话上下文",
    });
  });

  it("keeps current English and unknown command copy outside Chinese", () => {
    expect(rendererHarnessMessages("en")).toMatchObject({
      commands: "Commands",
      harnessCommands: "Harness commands",
      textArgument: "Text",
    });
    expect(rendererHarnessCommandPresentation(compactCommand, "en")).toEqual({
      label: "Compact context",
      description: "Compact the current conversation context",
    });
    expect(rendererHarnessCommandPresentation(customCommand, "zh-CN")).toEqual({
      label: "Explain",
      description: "Explain the current change",
    });
  });
});

import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiroAcpTransport } from "../src/acp-transport.js";
import type * as KiroCommand from "../src/command.js";

const native = vi.hoisted(() => ({
  model: "adjustable",
  effort: "low",
  ignoreEffort: false,
  emptyTemplates: 0,
  requests: [] as Array<{ method: string; params: Record<string, unknown> }>,
}));

function configOptions() {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: native.model,
      options: [
        {
          value: "adjustable",
          name: "Adjustable",
          _meta: {
            kiro: { hasEffort: true, effortLevels: ["low", "high"], defaultEffortLevel: "low" },
          },
        },
        { value: "fixed", name: "Fixed", _meta: { kiro: { hasEffort: false } } },
      ],
    },
    ...(native.model === "adjustable"
      ? [
          {
            type: "select",
            id: "effortLevel",
            name: "Effort",
            currentValue: native.effort,
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ]
      : []),
  ];
}

vi.mock("../src/command.js", async (original) => ({
  ...(await original<typeof KiroCommand>()),
  resolveKiroExecutable: () => process.execPath,
}));

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
    });
    let pending = "";
    child.stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      for (;;) {
        const index = pending.indexOf("\n");
        if (index < 0) break;
        const request = JSON.parse(pending.slice(0, index));
        pending = pending.slice(index + 1);
        native.requests.push(request);
        let result: unknown;
        if (request.method === "initialize")
          result = {
            protocolVersion: 1,
            authMethods: [{ id: "aws-builder-id", name: "AWS Builder ID" }],
            agentCapabilities: { _meta: { kiro: { extensionMethods: ["_kiro/config/template"] } } },
          };
        if (request.method === "authenticate") result = {};
        if (request.method === "_kiro/config/template")
          result = {
            configOptions:
              native.emptyTemplates-- > 0
                ? []
                : configOptions().filter((option) => option.id === "model"),
          };
        if (request.method === "session/new")
          result = { sessionId: "native", configOptions: configOptions() };
        if (request.method === "session/set_config_option") {
          if (request.params.configId === "model") native.model = request.params.value;
          if (request.params.configId === "effortLevel" && !native.ignoreEffort)
            native.effort = request.params.value;
          result = { configOptions: configOptions() };
        }
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
    });
    child.stdin.once("finish", () => {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  },
}));

let transport: KiroAcpTransport;
beforeEach(() => {
  native.model = "adjustable";
  native.effort = "low";
  native.ignoreEffort = false;
  native.emptyTemplates = 0;
  native.requests.length = 0;
  transport = new KiroAcpTransport({ cwd: process.cwd() });
});
afterEach(async () => {
  await transport.close();
});

describe("Kiro native effort configuration", () => {
  it("discovers per-model draft Thinking through the session-free native template", async () => {
    native.model = "fixed";
    native.emptyTemplates = 1;
    await expect(transport.inspect()).resolves.toMatchObject({
      catalog: {
        models: [
          { ref: { id: "adjustable" }, supportedThinkingOptionIds: ["low", "high"] },
          { ref: { id: "fixed" }, supportedThinkingOptionIds: [] },
        ],
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    });
    expect(native.requests.map(({ method }) => method)).toEqual([
      "initialize",
      "authenticate",
      "_kiro/config/template",
      "_kiro/config/template",
    ]);
  });

  it("bounds an empty native template instead of publishing false no-effort support", async () => {
    native.emptyTemplates = Infinity;
    await transport.close();
    transport = new KiroAcpTransport({ cwd: process.cwd(), commandTimeoutMs: 30 });
    await expect(transport.inspect()).rejects.toThrow("Kiro returned no native model catalog");
    expect(native.requests.some(({ method }) => method === "session/new")).toBe(false);
  });

  it("applies effort after model selection and returns native confirmation", async () => {
    const result = await transport.open({
      kind: "create",
      modelId: "adjustable",
      effortLevel: "high",
    });
    expect(result.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "effortLevel", currentValue: "high" }),
      ]),
    );
    expect(
      native.requests
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => request.params),
    ).toEqual([
      { sessionId: "native", configId: "model", value: "adjustable" },
      { sessionId: "native", configId: "effortLevel", value: "high" },
    ]);
  });

  it.each([
    ["fixed", "high", "unsupported"],
    ["adjustable", "max", "invalidRequest"],
  ])("rejects unavailable effort for %s without writing it", async (modelId, effortLevel, kind) => {
    await expect(transport.open({ kind: "create", modelId, effortLevel })).rejects.toMatchObject({
      kind,
    });
    expect(native.requests.some((request) => request.params?.configId === "effortLevel")).toBe(
      false,
    );
  });

  it("rejects an acknowledged write that did not change native effort", async () => {
    native.ignoreEffort = true;
    await expect(
      transport.open({ kind: "create", modelId: "adjustable", effortLevel: "high" }),
    ).rejects.toThrow("Failed to set effortLevel");
  });
});

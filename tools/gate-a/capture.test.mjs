import { describe, expect, it } from "vitest";

import { encodeRawCapture, parseRawCapture, sanitizeCapture } from "./capture.mjs";

function invocationRecord(overrides = {}) {
  return {
    schema_version: 1,
    platform: "windows",
    record_type: "invocation",
    timestamp_ms: 1000,
    process_id: 10,
    parent_process_id: 9,
    invocation_kind: "app-server",
    args: ["app-server"],
    cwd: String.raw`C:\Users\alice\project`,
    desktop_version: "26.721.4979.0",
    install_root: String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1`,
    stock_codex_path: String.raw`C:\Users\alice\AppData\Local\OpenAI\Codex\bin\hash\codex.exe`,
    environment_presence: { CODEX_CLI_PATH: true },
    ...overrides,
  };
}

describe("Gate A raw capture", () => {
  it("round-trips an allowlisted JSON record", () => {
    const record = invocationRecord({ args: ["app-server", "--stdio"] });
    expect(parseRawCapture(encodeRawCapture(record))).toEqual(record);
  });

  it("produces a versioned allowlisted invocation fixture", () => {
    const capture = sanitizeCapture(parseRawCapture(encodeRawCapture(invocationRecord())));
    expect(capture).toMatchObject({
      schemaVersion: 1,
      platform: "windows",
      recordType: "invocation",
      invocationKind: "app-server",
      args: ["app-server"],
      environmentPresence: { CODEX_CLI_PATH: true },
    });
    expect(capture).not.toHaveProperty("environment");
  });

  it("sanitizes a platform-discriminated macOS invocation", () => {
    const record = invocationRecord({
      platform: "macos",
      architecture: "arm64",
      process_group_id: 42,
      launch_mode: "launch-services",
      cwd: "/Users/alice/project",
      install_root: "/Applications/Codex.app",
      stock_codex_path: "/Applications/Codex.app/Contents/Resources/codex",
    });
    const capture = sanitizeCapture(record);
    expect(capture).toMatchObject({
      platform: "macos",
      architecture: "arm64",
      processGroupId: 42,
      launchMode: "launch-services",
      cwd: "<WORKING_DIRECTORY>",
      stockCodexPath: "<STOCK_CODEX>",
    });
  });

  it("sanitizes a platform-discriminated Linux invocation", () => {
    const record = invocationRecord({
      platform: "linux",
      architecture: "x64",
      process_group_id: 42,
      launch_mode: "direct-executable",
      cwd: "/home/alice/project",
      install_root: "/usr/lib/chatgpt",
      stock_codex_path: "/usr/lib/chatgpt/resources/codex",
    });
    const capture = sanitizeCapture(record);
    expect(capture).toMatchObject({
      platform: "linux",
      architecture: "x64",
      processGroupId: 42,
      launchMode: "direct-executable",
      cwd: "<WORKING_DIRECTORY>",
      stockCodexPath: "<STOCK_CODEX>",
    });
  });

  it("redacts sensitive argument values", () => {
    const record = invocationRecord({
      args: ["app-server", "authorization=Bearer secret-token"],
    });
    const capture = sanitizeCapture(parseRawCapture(encodeRawCapture(record)));
    expect(capture.args.at(-1)).toBe("<REDACTED>");
  });

  it("rejects malformed or non-object JSON captures", () => {
    expect(() => parseRawCapture(Buffer.from("bad"))).toThrow();
    expect(() => parseRawCapture(Buffer.from("[]"))).toThrow("JSON object");
    expect(() =>
      parseRawCapture(Buffer.concat([encodeRawCapture(invocationRecord()), Buffer.from([1])])),
    ).toThrow();
  });
});

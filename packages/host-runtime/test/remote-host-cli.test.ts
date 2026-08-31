import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { runRemoteHostCli } from "../src/remote-host-cli.js";

function textSink(): { output: Writable; text(): string } {
  const chunks: Buffer[] = [];
  return {
    output: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("remote SSH Host CLI", () => {
  it("prints a bounded command summary", async () => {
    const stdout = textSink();
    const stderr = textSink();

    await expect(
      runRemoteHostCli({
        arguments: ["--help"],
        output: stdout.output,
        diagnosticOutput: stderr.output,
      }),
    ).resolves.toBe(0);
    expect(stdout.text()).toContain("codexhost remote install");
    expect(stdout.text()).toContain("--grok-command PATH");
    expect(stdout.text()).toContain("codexhost remote start");
    expect(stdout.text()).toContain("codexhost remote stop");
    expect(stdout.text()).toContain("codexhost remote uninstall");
    expect(stderr.text()).toBe("");
  });

  it("reports an absent installation without mutating the host", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-cli-"));
    const stdout = textSink();
    const stderr = textSink();
    try {
      await expect(
        runRemoteHostCli({
          arguments: ["status"],
          environment: { HOME: home, SHELL: "/bin/zsh" },
          output: stdout.output,
          diagnosticOutput: stderr.output,
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(stdout.text())).toMatchObject({
        state: "not-installed",
        runtime: { state: "stopped" },
      });
      expect(stderr.text()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses lifecycle operations before installation", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-remote-cli-"));
    const expectedMessage =
      process.platform === "win32"
        ? "Remote Host lifecycle must run on the macOS or Linux SSH host"
        : "Remote Host is not installed";
    try {
      for (const command of ["start", "stop"]) {
        const stdout = textSink();
        const stderr = textSink();
        await expect(
          runRemoteHostCli({
            arguments: [command],
            environment: { HOME: home, SHELL: "/bin/bash" },
            output: stdout.output,
            diagnosticOutput: stderr.output,
          }),
        ).resolves.toBe(1);
        expect(stdout.text()).toBe("");
        expect(stderr.text()).toContain(expectedMessage);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails closed on unknown commands and options", async () => {
    const stdout = textSink();
    const stderr = textSink();

    await expect(
      runRemoteHostCli({
        arguments: ["install", "--unknown", "value"],
        output: stdout.output,
        diagnosticOutput: stderr.output,
      }),
    ).resolves.toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Unknown remote option '--unknown'");
  });
});

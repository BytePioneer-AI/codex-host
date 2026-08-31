import { describe, expect, it } from "vitest";

import {
  remoteGrokNeedsSetup,
  remoteGrokSetupVariant,
  resolveRemoteGrokSetupCopy,
} from "../src/renderer-remote-grok-setup.js";

describe("remote Grok setup prompt", () => {
  it("only prompts on a remote SSH Host when Grok is not ready", () => {
    expect(remoteGrokNeedsSetup("local", "error")).toBe(false);
    expect(remoteGrokNeedsSetup("remote-ssh-discovered:uts", "ready")).toBe(false);
    expect(remoteGrokNeedsSetup("remote-ssh-discovered:uts", "checking")).toBe(false);
    expect(remoteGrokNeedsSetup("remote-ssh-discovered:uts", "error")).toBe(true);
    expect(remoteGrokNeedsSetup("remote-ssh-discovered:uts", "notInstalled")).toBe(true);
  });

  it("maps occupancy to a blocked prompt instead of automatic install", () => {
    expect(remoteGrokSetupVariant("official-remote-control")).toBe("blocked-official");
    expect(remoteGrokSetupVariant("unknown-busy")).toBe("blocked-unknown");
    expect(remoteGrokSetupVariant("grok-missing")).toBe("grok-missing");
    expect(remoteGrokSetupVariant("idle")).toBe("install");
  });

  it("explains official daemon occupancy with the SSH target and agent label", () => {
    const copy = resolveRemoteGrokSetupCopy("blocked-official", "company-box", "Claude Code");
    expect(copy.title).toBe("需要你的允许才能建立 Claude Code 的远程连接");
    expect(copy.body).toContain("目前 company-box 上面已经运行着 Codex SSH daemon");
    expect(copy.body).not.toContain("UTS");
    expect(copy.body).toContain("Claude Code 和 Codex");
    expect(copy.body).toContain("会替您把这条 SSH 连接的 Codex SSH daemon 重新建立起来");
    expect(copy.body).toContain("停掉官方入口并安装");
  });
});

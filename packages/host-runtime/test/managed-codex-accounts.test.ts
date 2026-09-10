import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { CodexCredentialFiles } from "../src/account/codex-credential-files.js";
import { ManagedCodexAccounts } from "../src/account/managed-codex-accounts.js";
import { ManagedCodexAccountQuotas } from "../src/account/managed-codex-account-quotas.js";
import { NativeCodexCredentials } from "../src/account/native-codex-credentials.js";
import type { OfficialAccountRuntime } from "../src/account/official-account-runtime.js";
import { SavedCodexAccounts } from "../src/account/saved-codex-accounts.js";
import type { CodexAccountSwitcher } from "../src/account/codex-account-switcher.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { syntheticNativeCredentials } from "./fixtures/codex-account-fixtures.js";
import { MemoryCredentialFiles } from "./fixtures/memory-credential-files.js";

describe("ManagedCodexAccounts login", () => {
  it("uses the sole runtime transaction and commits verified native credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-managed-account-"));
    const files = new MemoryCredentialFiles();
    const home = path.join(root, "home");
    const slots = path.join(root, "slots");
    const credentials = new CodexCredentialFiles({
      files,
      directory: slots,
      sharedCodexHome: home,
    });
    const lease = await credentials.initialize();
    const accounts = new SavedCodexAccounts({
      directory: path.join(root, "registry"),
      sharedCodexHome: home,
    });
    await accounts.initialize();
    const gate = new OfficialWorkGate();
    gate.initialized();
    const runtime = {
      preflight: vi.fn(async () => undefined),
      assertNativeIdle: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
      controlRequest: vi.fn(async () => ({
        result: {
          type: "chatgptDeviceCode",
          loginId: "login-1",
          verificationUrl: "https://example.com/device",
          userCode: "ABCD-EFGH",
        },
      })),
    } as unknown as OfficialAccountRuntime;
    const managed = new ManagedCodexAccounts({
      accounts,
      credentials,
      runtime,
      switcher: { recover: vi.fn(), switch: vi.fn() } as unknown as CodexAccountSwitcher,
      journal: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
      gate,
      quotas: new ManagedCodexAccountQuotas({ files, directory: slots, credentials }),
    });

    try {
      const started = await managed.startLogin();
      expect(started.userCode).toBe("ABCD-EFGH");
      expect(gate.phase).toBe("changing");
      files.nativeWrite(home, "auth.json", syntheticNativeCredentials({ subject: "new-user" }));
      const completed = new Promise<Parameters<Parameters<typeof managed.subscribeLogin>[0]>[0]>(
        (resolve) => managed.subscribeLogin(resolve),
      );
      managed.observe({
        method: "account/login/completed",
        params: { loginId: "login-1", success: true, error: null },
      });
      await expect(completed).resolves.toMatchObject({ success: true, loginId: "login-1" });
      expect(managed.snapshot()).toMatchObject({
        phase: "ready",
        currentAccountId: started.accountId,
      });
      expect(managed.snapshot().accounts).toEqual([
        expect.objectContaining({ accountId: started.accountId, email: "new-user@example.com" }),
      ]);
      expect(runtime.controlRequest).toHaveBeenCalledTimes(1);
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves a newly authenticated Account and restores the existing current Account", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-managed-account-source-"));
    const files = new MemoryCredentialFiles();
    const home = path.join(root, "home");
    const slots = path.join(root, "slots");
    const credentials = new CodexCredentialFiles({
      files,
      directory: slots,
      sharedCodexHome: home,
    });
    const lease = await credentials.initialize();
    const accounts = new SavedCodexAccounts({
      directory: path.join(root, "registry"),
      sharedCodexHome: home,
    });
    await accounts.initialize();
    const source = NativeCodexCredentials.parse(
      syntheticNativeCredentials({ subject: "source", generation: 2 }),
    );
    files.nativeWrite(home, "auth.json", source.serializeForNativeStore());
    const savedSource = await accounts.saveVerifiedAccount({
      identity: source.identity,
      ...(source.email ? { email: source.email } : {}),
      label: "Source",
    });
    await credentials.save(savedSource, source);
    await accounts.setCurrentAccountId(savedSource.accountId);
    const gate = new OfficialWorkGate();
    gate.initialized();
    const runtime = {
      preflight: vi.fn(async () => undefined),
      assertNativeIdle: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
      controlRequest: vi.fn(async () => ({
        result: {
          type: "chatgptDeviceCode",
          loginId: "login-2",
          verificationUrl: "https://example.com/device",
          userCode: "IJKL-MNOP",
        },
      })),
    } as unknown as OfficialAccountRuntime;
    const managed = new ManagedCodexAccounts({
      accounts,
      credentials,
      runtime,
      switcher: { recover: vi.fn(), switch: vi.fn() } as unknown as CodexAccountSwitcher,
      journal: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
      gate,
      quotas: new ManagedCodexAccountQuotas({ files, directory: slots, credentials }),
    });
    try {
      const started = await managed.startLogin();
      files.nativeWrite(home, "auth.json", syntheticNativeCredentials({ subject: "added" }));
      const completed = new Promise<Parameters<Parameters<typeof managed.subscribeLogin>[0]>[0]>(
        (resolve) => managed.subscribeLogin(resolve),
      );
      managed.observe({
        method: "account/login/completed",
        params: { loginId: started.loginId, success: true, error: null },
      });
      await expect(completed).resolves.toMatchObject({ success: true });
      expect(managed.currentAccountId()).toBe(savedSource.accountId);
      expect((await credentials.readCurrent())?.identity).toEqual(source.identity);
      expect(managed.snapshot().accounts).toHaveLength(2);

      const relogin = await managed.startLogin(savedSource.accountId);
      const refreshedSource = syntheticNativeCredentials({ subject: "source", generation: 3 });
      files.nativeWrite(home, "auth.json", refreshedSource);
      const reloginCompleted = new Promise<
        Parameters<Parameters<typeof managed.subscribeLogin>[0]>[0]
      >((resolve) => managed.subscribeLogin(resolve));
      managed.observe({
        method: "account/login/completed",
        params: { loginId: relogin.loginId, success: true, error: null },
      });
      await expect(reloginCompleted).resolves.toMatchObject({
        success: true,
        accountId: savedSource.accountId,
      });
      expect((await credentials.readCurrent())?.serializeForNativeStore()).toBe(refreshedSource);
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not classify a non-mutating inactive quota read as official busy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-managed-account-quota-gate-"));
    const files = new MemoryCredentialFiles();
    const home = path.join(root, "home");
    const slots = path.join(root, "slots");
    const credentials = new CodexCredentialFiles({
      files,
      directory: slots,
      sharedCodexHome: home,
    });
    const lease = await credentials.initialize();
    const accounts = new SavedCodexAccounts({
      directory: path.join(root, "registry"),
      sharedCodexHome: home,
    });
    await accounts.initialize();
    const a = NativeCodexCredentials.parse(syntheticNativeCredentials({ subject: "gate-a" }));
    const b = NativeCodexCredentials.parse(syntheticNativeCredentials({ subject: "gate-b" }));
    const savedA = await accounts.saveVerifiedAccount({ identity: a.identity, label: "A" });
    const savedB = await accounts.saveVerifiedAccount({ identity: b.identity, label: "B" });
    await accounts.setCurrentAccountId(savedA.accountId);
    const quota = Promise.withResolvers<{
      accountId: string;
      usage: null;
      freshness: "live";
      observedAt: string;
    }>();
    const gate = new OfficialWorkGate();
    gate.initialized();
    const managed = new ManagedCodexAccounts({
      accounts,
      credentials,
      runtime: {} as OfficialAccountRuntime,
      switcher: {} as CodexAccountSwitcher,
      journal: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
      gate,
      quotas: {
        inspect: vi.fn(() => quota.promise),
      } as unknown as ManagedCodexAccountQuotas,
    });
    try {
      const reading = managed.inspectInactiveUsage(savedB.accountId, true);
      expect(gate.busy).toBe(false);
      const change = gate.beginChange();
      change.finish("ready");
      quota.resolve({
        accountId: savedB.accountId,
        usage: null,
        freshness: "live",
        observedAt: "2026-09-10T03:00:00.000Z",
      });
      await reading;
      expect(gate.busy).toBe(false);
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a late login success after cancellation and restores signed-out state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-managed-account-cancel-"));
    const files = new MemoryCredentialFiles();
    const home = path.join(root, "home");
    const credentials = new CodexCredentialFiles({
      files,
      directory: path.join(root, "slots"),
      sharedCodexHome: home,
    });
    const lease = await credentials.initialize();
    const accounts = new SavedCodexAccounts({
      directory: path.join(root, "registry"),
      sharedCodexHome: home,
    });
    await accounts.initialize();
    const gate = new OfficialWorkGate();
    gate.initialized();
    const runtime = {
      preflight: vi.fn(async () => undefined),
      assertNativeIdle: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
      controlRequest: vi.fn(async (method: string) =>
        method === "account/login/start"
          ? {
              result: {
                type: "chatgptDeviceCode",
                loginId: "login-cancel",
                verificationUrl: "https://example.com/device",
                userCode: "QRST-UVWX",
              },
            }
          : { result: {} },
      ),
    } as unknown as OfficialAccountRuntime;
    const managed = new ManagedCodexAccounts({
      accounts,
      credentials,
      runtime,
      switcher: { recover: vi.fn(), switch: vi.fn() } as unknown as CodexAccountSwitcher,
      journal: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
      gate,
      quotas: new ManagedCodexAccountQuotas({
        files,
        directory: path.join(root, "slots"),
        credentials,
      }),
    });
    try {
      const started = await managed.startLogin();
      expect(await managed.cancelLogin(started.loginId)).toBe(true);
      files.nativeWrite(home, "auth.json", syntheticNativeCredentials({ subject: "late" }));
      managed.observe({
        method: "account/login/completed",
        params: { loginId: started.loginId, success: true, error: null },
      });
      await vi.waitFor(() => {
        expect(managed.currentAccountId()).toBeNull();
        expect(managed.snapshot()).toMatchObject({ phase: "ready", accounts: [] });
      });
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });
});

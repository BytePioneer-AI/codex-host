import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAccountSwitcher,
  type SwitchingOfficialRuntime,
} from "../src/account/codex-account-switcher.js";
import {
  CodexCredentialFiles,
  codexCredentialStorageSupport,
} from "../src/account/codex-credential-files.js";
import { FileCredentialSwitchJournal } from "../src/account/credential-switch-journal.js";
import {
  NativeCodexCredentials,
  sameCodexCredentialIdentity,
} from "../src/account/native-codex-credentials.js";
import { SavedCodexAccounts } from "../src/account/saved-codex-accounts.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { syntheticNativeCredentials } from "./fixtures/codex-account-fixtures.js";
import { MemoryCredentialFiles } from "./fixtures/memory-credential-files.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const document = (subject: string, generation = 1) =>
  NativeCodexCredentials.parse(syntheticNativeCredentials({ subject, generation }));

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "codexhost-switch-"));
  directories.push(directory);
  const home = path.join(directory, "home");
  const slots = path.join(directory, "slots");
  const accounts = new SavedCodexAccounts({ directory, sharedCodexHome: home });
  await accounts.initialize();
  const a = await accounts.saveVerifiedAccount({ identity: document("a").identity });
  const b = await accounts.saveVerifiedAccount({ identity: document("b").identity });
  await accounts.setCurrentAccountId(a.accountId);
  const files = new MemoryCredentialFiles();
  const credentials = new CodexCredentialFiles({ directory: slots, sharedCodexHome: home, files });
  const lease = await credentials.initialize();
  await credentials.save(a, document("a"));
  await credentials.save(b, document("b"));
  files.nativeWrite(home, "auth.json", document("a").serializeForNativeStore());
  const journal = new FileCredentialSwitchJournal(files, slots);
  const gate = new OfficialWorkGate();
  gate.initialized();
  const events: string[] = [];
  let running = true;
  files.beforeReplace = (target) => {
    if (target === home && running)
      throw new Error("Credential write while official process alive");
    events.push(target === home ? "install" : "persist");
  };
  const runtime = {
    preflight: vi.fn(async () => {
      events.push("preflight");
    }),
    assertNativeIdle: vi.fn(async () => {
      events.push("idle");
    }),
    stop: vi.fn(async () => {
      events.push("stop");
      running = false;
    }),
    start: vi.fn(async () => {
      if (running) throw new Error("Two live official processes");
      events.push("start");
      running = true;
    }),
    verify: vi.fn<SwitchingOfficialRuntime["verify"]>(async (identity) => {
      events.push("verify");
      const actual = await credentials.readCurrent();
      if (
        identity
          ? !actual || !sameCodexCredentialIdentity(identity, actual.identity)
          : actual !== null
      )
        throw new Error("Synthetic identity mismatch");
    }),
  };
  const create = () => new CodexAccountSwitcher({ accounts, credentials, journal, runtime, gate });
  return {
    directory,
    home,
    slots,
    accounts,
    a,
    b,
    files,
    credentials,
    journal,
    gate,
    runtime,
    events,
    create,
    switcher: create(),
    lease,
  };
}

describe("global Codex credential transaction", () => {
  it("saves native rotation after real stop and switches A→B→A without token downgrade", async () => {
    const f = await fixture();
    const stop = f.runtime.stop.getMockImplementation();
    f.runtime.stop.mockImplementationOnce(async () => {
      f.files.nativeWrite(f.home, "auth.json", document("a", 2).serializeForNativeStore());
      await stop?.();
    });
    await f.switcher.switch(f.b.accountId);
    expect(f.accounts.getCurrentAccountId()).toBe(f.b.accountId);
    expect((await f.credentials.load(f.a)).serializeForNativeStore()).toBe(
      document("a", 2).serializeForNativeStore(),
    );
    expect(f.events.indexOf("stop")).toBeLessThan(f.events.indexOf("install"));
    expect(f.events.indexOf("install")).toBeLessThan(f.events.indexOf("start"));
    expect(f.gate.phase).toBe("ready");
    await f.switcher.switch(f.a.accountId);
    expect((await f.credentials.readCurrent())?.serializeForNativeStore()).toBe(
      document("a", 2).serializeForNativeStore(),
    );
    expect(await f.journal.read()).toBeNull();
  });

  it("rejects busy without stopping, and never queues input or concurrent switching", async () => {
    const f = await fixture();
    const finish = f.gate.admit();
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({ code: "busy" });
    expect(f.runtime.stop).not.toHaveBeenCalled();
    finish();
    const pending = f.switcher.switch(f.b.accountId);
    expect(() => f.gate.admit()).toThrow("changing");
    await expect(f.switcher.switch(f.a.accountId)).rejects.toMatchObject({ code: "changing" });
    await pending;
    const stops = f.runtime.stop.mock.calls.length;
    await f.switcher.switch(f.b.accountId);
    expect(f.runtime.stop).toHaveBeenCalledTimes(stops);
  });

  it("preserves a native idle-check busy error before stopping", async () => {
    const f = await fixture();
    f.runtime.assertNativeIdle.mockRejectedValue(
      Object.assign(new Error("Native Codex work is active"), { code: "busy" }),
    );
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({ code: "busy" });
    expect(f.runtime.stop).not.toHaveBeenCalled();
    expect(f.gate.phase).toBe("ready");
  });

  it("rejects corrupt UTF-8 rather than silently rewriting native credential bytes", async () => {
    const f = await fixture();
    const damaged = document("a")
      .serializeForNativeStore()
      .replace("synthetic-refresh-a-1", "synthetic-\u00ff");
    f.files.contents.set(`${f.home}/auth.json`, Buffer.from(damaged, "latin1"));
    await expect(f.credentials.readCurrent()).rejects.toMatchObject({ code: "invalid" });
    expect((await f.credentials.load(f.a)).serializeForNativeStore()).toBe(
      document("a").serializeForNativeStore(),
    );
  });

  it("does not install credentials when process exit is unconfirmed", async () => {
    const f = await fixture();
    f.runtime.stop.mockRejectedValue(new Error("Synthetic stop timeout"));
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({
      code: "stop-unconfirmed",
    });
    expect(f.events).not.toContain("install");
    expect(f.runtime.start).not.toHaveBeenCalled();
    expect(f.gate.phase).toBe("unavailable");
  });

  it("preserves B rotation before rolling back a failed B verification", async () => {
    const f = await fixture();
    f.runtime.verify.mockImplementationOnce(async () => {
      f.files.nativeWrite(f.home, "auth.json", document("b", 3).serializeForNativeStore());
      throw new Error("Synthetic authentication failure");
    });
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({ code: "switch-failed" });
    expect(f.gate.phase).toBe("ready");
    expect(f.accounts.getCurrentAccountId()).toBe(f.a.accountId);
    expect((await f.credentials.load(f.b)).serializeForNativeStore()).toBe(
      document("b", 3).serializeForNativeStore(),
    );
    expect((await f.credentials.readCurrent())?.identity).toEqual(f.a.identity);
  });

  it("keeps the authoritative A file if saving A fails instead of reinstalling its old slot", async () => {
    const f = await fixture();
    f.files.nativeWrite(f.home, "auth.json", document("a", 4).serializeForNativeStore());
    const before = f.files.beforeReplace;
    f.files.beforeReplace = (directory, name) => {
      if (name === `${f.a.accountId}.auth.json`) throw new Error("Synthetic disk failure");
      before?.(directory, name);
    };
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({ code: "switch-failed" });
    expect(f.gate.phase).toBe("ready");
    expect(f.events).not.toContain("install");
    expect((await f.credentials.readCurrent())?.serializeForNativeStore()).toBe(
      document("a", 4).serializeForNativeStore(),
    );
  });

  it("recovers when installation throws after the native file was already replaced", async () => {
    const f = await fixture();
    f.files.afterReplace = (directory) => {
      if (directory === f.home) {
        f.files.afterReplace = undefined;
        throw new Error("Synthetic lost acknowledgement");
      }
    };
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({ code: "switch-failed" });
    expect(f.gate.phase).toBe("ready");
    expect((await f.credentials.readCurrent())?.identity).toEqual(f.a.identity);
  });

  it("rejects an already changed identity before stopping or writing", async () => {
    const f = await fixture();
    f.files.nativeWrite(f.home, "auth.json", document("b", 9).serializeForNativeStore());
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({
      code: "recovery-required",
    });
    expect(f.runtime.stop).not.toHaveBeenCalled();
    expect(f.gate.phase).toBe("unavailable");
    expect((await f.credentials.readCurrent())?.serializeForNativeStore()).toBe(
      document("b", 9).serializeForNativeStore(),
    );
  });

  it("does not overwrite an external identity changed after the initial check", async () => {
    const f = await fixture();
    f.runtime.assertNativeIdle.mockImplementation(async () => {
      f.files.nativeWrite(f.home, "auth.json", document("b", 9).serializeForNativeStore());
    });
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({
      code: "rollback-failed",
    });
    expect(f.gate.phase).toBe("unavailable");
    expect(f.events).not.toContain("install");
    expect((await f.credentials.load(f.b)).serializeForNativeStore()).toBe(
      document("b").serializeForNativeStore(),
    );
    expect((await f.credentials.readCurrent())?.serializeForNativeStore()).toBe(
      document("b", 9).serializeForNativeStore(),
    );
  });

  it("keeps admission closed when replacement and rollback verification fail", async () => {
    const f = await fixture();
    f.runtime.verify.mockRejectedValue(new Error("Synthetic network failure"));
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({
      code: "rollback-failed",
    });
    expect(f.gate.phase).toBe("unavailable");
    expect(await f.journal.read()).not.toBeNull();
  });

  it("retains a verified recovery record if metadata commit acknowledgement fails", async () => {
    const f = await fixture();
    const commit = f.accounts.setCurrentAccountId.bind(f.accounts);
    vi.spyOn(f.accounts, "setCurrentAccountId").mockImplementationOnce(async (id) => {
      await commit(id);
      throw new Error("Synthetic lost commit acknowledgement");
    });
    await expect(f.switcher.switch(f.b.accountId)).rejects.toMatchObject({
      code: "recovery-required",
    });
    expect(f.gate.phase).toBe("unavailable");
    expect((await f.journal.read())?.stage).toBe("verified");
    expect(f.accounts.getCurrentAccountId()).toBe(f.b.accountId);
    await f.create().recover();
    expect(f.gate.phase).toBe("ready");
    expect((await f.credentials.readCurrent())?.identity).toEqual(f.b.identity);
  });

  it.each(["source-saved", "target-installed", "verified"] as const)(
    "recovers a crash at %s without trusting the old pointer",
    async (stage) => {
      const f = await fixture();
      await f.journal.write({
        version: 1,
        transactionId: "11111111-1111-4111-8111-111111111111",
        operation: "switch",
        sourceAccountId: f.a.accountId,
        targetAccountId: f.b.accountId,
        stage,
      });
      f.files.nativeWrite(f.home, "auth.json", document("b", 6).serializeForNativeStore());
      f.gate.unavailable();
      await f.create().recover();
      expect(f.accounts.getCurrentAccountId()).toBe(f.a.accountId);
      expect((await f.credentials.readCurrent())?.identity).toEqual(f.a.identity);
      expect((await f.credentials.load(f.b)).serializeForNativeStore()).toBe(
        document("b", 6).serializeForNativeStore(),
      );
      expect(await f.journal.read()).toBeNull();
    },
  );
});

describe("native credential storage capability", () => {
  it.each([undefined, "auto", "keyring", "unknown"])(
    "does not guess %s to be file storage",
    (effectiveCredentialStore) => {
      expect(
        codexCredentialStorageSupport({
          nativeFileInterfaceAvailable: true,
          effectiveCredentialStore,
          environment: {},
        }).supported,
      ).toBe(false);
    },
  );
  it("rejects externally supplied credentials without modifying configuration", () => {
    expect(
      codexCredentialStorageSupport({
        nativeFileInterfaceAvailable: true,
        effectiveCredentialStore: "file",
        environment: { OPENAI_API_KEY: "synthetic-secret" },
      }),
    ).toEqual({ supported: false, reason: "external-credentials" });
    expect(
      codexCredentialStorageSupport({
        nativeFileInterfaceAvailable: true,
        effectiveCredentialStore: "file",
        environment: {},
      }),
    ).toEqual({ supported: true });
  });
});

// Opt-in, no-model native smoke. Never reads the user's MiMo profile.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { MimoAdapter } from "../dist/adapter.js";
import { connectMimo } from "../dist/server.js";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
const root = await mkdtemp(path.join(tmpdir(), "codexhost-mimo-adapter-"));
const cwd = path.join(root, "cwd");
const profile = path.join(root, "profile");
await Promise.all([mkdir(cwd), mkdir(profile)]);
const allowed = new Set([
  "path",
  "pathext",
  "systemroot",
  "windir",
  "comspec",
  "temp",
  "tmp",
  "userprofile",
  "localappdata",
  "appdata",
  "programfiles",
  "programfiles(x86)",
]);
const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())),
  ),
  MIMOCODE_HOME: profile,
  MIMOCODE_PURE: "true",
  MIMOCODE_MIMO_ONLY: "true",
  MIMOCODE_DISABLE_AUTOUPDATE: "true",
  MIMOCODE_DISABLE_CLAUDE_CODE: "true",
};
const command = path.join(
  homedir(),
  ".mimocode",
  "bin",
  process.platform === "win32" ? "mimo.exe" : "mimo",
);
const adapter = new MimoAdapter({ environment, command });
let probe;
try {
  const inspection = await adapter.inspect({ cwd });
  // 0.1.14 includes a configured free-tier MiMo provider even with an empty
  // auth store. A ready catalog does not prove external model authentication.
  assert.equal(inspection.status, "ready");
  const opened = await adapter.open({
    kind: "create",
    cwd,
    environment: { MIMO_ADAPTER_TEST: "isolated" },
    permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
  });
  assert.equal(opened.ok, true, opened.ok ? undefined : JSON.stringify(opened.error));
  const session = opened.value;
  const nativeRef = session.initialState.nativeRef;
  assert.ok(nativeRef);
  assert.deepEqual((await session.readSnapshot()).value.turns, []);
  const duplicate = await adapter.open({ kind: "resume", cwd, nativeRef });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, "sessionBusy");
  assert.equal(
    (
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
      })
    ).ok,
    false,
  );
  assert.equal((await session.readSnapshot()).value.state.effectivePermissionModeId, "ask");
  await session.close();
  const resumed = await adapter.open({ kind: "resume", cwd, nativeRef });
  assert.equal(resumed.ok, true, resumed.ok ? undefined : JSON.stringify(resumed.error));
  assert.deepEqual(resumed.value.initialState.nativeRef, nativeRef);
  await resumed.value.close();
  probe = await connectMimo({ cwd, environment, command });
  const rule = [{ permission: "*", pattern: "*", action: "ask" }];
  const update = await probe.client.session.update({
    sessionID: nativeRef.nativeSessionId,
    permission: rule,
  });
  assert.deepEqual(update.data?.permission, [...rule, ...rule]);
  const reread = await probe.client.session.get({ sessionID: nativeRef.nativeSessionId });
  assert.deepEqual(reread.data?.permission, [...rule, ...rule]);
  const providers = await probe.client.provider.list();
  assert.ok(providers.data);
  const modelAvailability = {
    connectedProviders: providers.data.connected,
    authenticatedProviders: providers.data.authenticated,
    models: providers.data.all
      .filter((provider) => providers.data.connected.includes(provider.id))
      .flatMap((provider) => Object.keys(provider.models).map((id) => `${provider.id}/${id}`)),
  };
  console.log(
    JSON.stringify({
      nativeVersion: (await probe.client.global.health()).data.version,
      create: true,
      eventHandshake: true,
      emptySnapshot: true,
      resumeAcrossProcesses: true,
      permissionUpdateAppends: true,
      duplicateOpenRejected: true,
      permissionAtCreateReadback: true,
      modelCalls: 0,
      isolatedProfile: true,
      modelAvailability,
    }),
  );
} finally {
  await probe?.close();
  await adapter.close();
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("codexhost-mimo-adapter-"))
    throw new Error("Unexpected smoke cleanup path");
  await rm(root, { recursive: true, force: true });
}

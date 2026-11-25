import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { harnessModelRefSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { OmpAdapter } from "../src/omp-adapter.js";
import { openOmpBillingSource } from "../src/omp-billing-source-session.js";

// The child runs the production bridge extension against a fake native SDK and two OAuth rows.
const executable = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
process.on('uncaughtException', error => {
  appendFileSync(process.env.FAKE_OMP_ATTEMPTS + '.error', String(error));
  process.exitCode = 1;
});
import { createInterface } from 'node:readline';
const models = [
  { provider: 'fake-oauth', id: 'series/short', reasoning: false },
  { provider: 'fake-oauth/series', id: 'short', reasoning: false },
  { provider: 'fake-oauth', id: 'short', reasoning: false },
  { provider: 'other', id: 'short', reasoning: false },
];
const identityFile = process.env.FAKE_OMP_IDENTITIES;
const saved = identityFile ? JSON.parse(readFileSync(identityFile, 'utf8')) : {};
const rows = [11, 22].map(id => ({ id, provider: 'fake-oauth', identityKey: saved[id] || 'native-' + id, credential: { type: 'oauth' } }));
const saveIdentities = () => {
  if (identityFile) writeFileSync(identityFile, JSON.stringify(Object.fromEntries(rows.map(row => [row.id, row.identityKey]))));
};
if (process.argv[2] === 'usage') {
  process.stdout.write(JSON.stringify({ reports: rows.map(row => ({ provider: row.provider, metadata: { credentialId: row.id, identityKey: row.identityKey }, limits: [{ amount: { usedFraction: row.id / 100 } }] })) }));
} else if (process.argv[2] === 'models') {
  process.stdout.write(JSON.stringify({ models }));
} else {
  const p = process.argv.indexOf('--extension');
  if (p < 0 || !process.argv.includes('--no-session')) throw new Error('Not a native no-session launch');
  const source = readFileSync(process.argv[p + 1], 'utf8').split('export default function')[1];
  const sdk = {
    Settings: { isolated: () => ({}) },
    SessionManager: { inMemory: () => ({ getSessionFile: () => undefined }) },
    async createAgentSession(opts) {
      if (!opts.disableModelFallback || !opts.disableServerSideFallback || !opts.restrictToolNames || opts.toolNames.length) throw new Error('widened dispatch');
      const session = {
        model: opts.model, messages: [],
        async prompt(text) {
          opts.assertDispatchModel(opts.model);
          const pool = opts.oauthAccountPools?.[opts.model.provider];
          const row = rows.find(row => pool?.includes(row.identityKey) && !(text === 'deny A' && row.id === 11));
          if (!row || pool.length !== 1) throw new Error('unavailable');
          appendFileSync(process.env.FAKE_OMP_ATTEMPTS, row.id + ':' + row.identityKey + '\n');
          this.messages.push({ role: 'assistant', stopReason: 'stop', provider: row.provider, credentialId: row.id, identityKey: row.identityKey });
          if (text === 'swap slot') {
            rows[0].identityKey = 'native-third';
            saveIdentities();
          }
          if (text === 'lose cleanup') this.loseCleanup = true;
        },
        async waitForIdle() {},
        async dispose() { if (this.loseCleanup) throw new Error('disposal did not acknowledge'); },
      };
      return { session };
    },
  };
  const registry = {
    authStorage: { credentials: { async revalidate() {}, snapshot: () => ({ credentials: rows }) } },
    getAvailable: () => process.env.FAKE_OMP_BLANK_MODEL ? [{ ...models[0], id: ' ' }] : models,
    find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
  };
  let handler;
  new Function('sdk', 'const {createAgentSession, SessionManager, Settings} = sdk; return function' + source)(sdk)({
    registerCommand(name, spec) { handler = spec.handler; },
  });
  process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const prompt = JSON.parse(line);
    const args = prompt.message.split(' ')[1];
    const request = JSON.parse(Buffer.from(args, 'base64url').toString('utf8'));
    if (request.type === 'turn' && request.text === 'reject before dispatch') {
      process.stdout.write(JSON.stringify({ id: prompt.id, type: 'response', success: false }) + '\n');
      continue;
    }
    await handler(args, { cwd: process.cwd(), modelRegistry: registry });
    process.stdout.write(JSON.stringify({ id: prompt.id, type: 'prompt_result', agentInvoked: false, status: 'completed' }) + '\n');
  }
}
`;

it("runs distinct OMP Billing Sources without fallback and requires native cleanup proof", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ch-omp-binding-test-"));
  const script = path.join(directory, "fake-omp.mjs");
  const launches = path.join(directory, "attempts.log");
  const identities = path.join(directory, "identities.json");
  const windows = process.platform === "win32";
  const command = path.join(directory, windows ? "omp.cmd" : "omp");
  const environment = { FAKE_OMP_ATTEMPTS: launches, FAKE_OMP_IDENTITIES: identities };
  const adapter = new OmpAdapter({
    command,
    environment: { ...environment, PI_CODING_AGENT_DIR: path.join(directory, "primary") },
  });
  const otherProfile = new OmpAdapter({
    command,
    environment: { ...environment, PI_CODING_AGENT_DIR: path.join(directory, "other") },
  });
  try {
    await writeFile(script, executable, "utf8");
    await writeFile(identities, "{}", "utf8");
    await writeFile(
      command,
      windows
        ? `@"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    const accounts = await adapter.inspectAccounts();
    const [a, b] = accounts.map((account) => account.billingSourceRef);
    if (!a || !b) throw new Error("Fake quotas did not carry Billing Source references");
    expect(a).not.toEqual(b);
    const create = { kind: "create" as const, cwd: directory };
    const collisionRef = harnessModelRefSchema.parse({
      id: `omp-model-v1.${Buffer.from(JSON.stringify(["fake-oauth", "series/short"])).toString("base64url")}`,
    });
    const readableRef = harnessModelRefSchema.parse({ id: "fake-oauth/short" });
    for (const model of [collisionRef, readableRef]) {
      const opened = await adapter.openBillingSource({ ...create, billingSourceRef: a, model });
      if (!opened.ok) throw new Error(opened.error.message);
      try {
        expect(opened.value.initialState.effectiveModel).toEqual(model);
      } finally {
        await opened.value.close();
      }
    }
    expect(
      await adapter.openBillingSource({
        ...create,
        billingSourceRef: a,
        model: harnessModelRefSchema.parse({ id: "other/short" }),
      }),
    ).toMatchObject({ ok: false });
    const otherRefs = (await otherProfile.inspectAccounts()).map(
      (account) => account.billingSourceRef,
    );
    const otherA = otherRefs[0];
    if (!otherA) throw new Error("Second Profile did not discover its Billing Source");
    const otherOpen = await otherProfile.openBillingSource({ ...create, billingSourceRef: otherA });
    if (!otherOpen.ok) throw new Error(otherOpen.error.message);
    expect(otherOpen.value.initialState.effectiveModel).toEqual(collisionRef);
    await otherOpen.value.close();
    expect(otherRefs).not.toContainEqual(a);
    expect(await otherProfile.openBillingSource({ ...create, billingSourceRef: a })).toMatchObject({
      ok: false,
    });
    expect(
      await adapter.openBillingSource({ ...create, billingSourceRef: { ...b, id: "stale" } }),
    ).toMatchObject({ ok: false });
    const directOpen = {
      ...create,
      command,
      environment,
      billingSourceRef: a,
      target: { provider: "fake-oauth", credentialId: 11, identityKey: "native-11" },
    };
    expect(
      await openOmpBillingSource({
        ...directOpen,
        target: { ...directOpen.target, modelId: "missing" },
      }),
    ).toMatchObject({ ok: false, nativeCleanup: "not-persisted" });
    expect(
      await openOmpBillingSource({
        ...directOpen,
        environment: { ...environment, FAKE_OMP_BLANK_MODEL: "1" },
      }),
    ).toMatchObject({ ok: false, nativeCleanup: "not-persisted" });
    const run = async (billingSourceRef: typeof a, text: string) => {
      const opened = await adapter.openBillingSource({ ...create, billingSourceRef });
      if (!opened.ok) {
        const diagnostic = await readFile(launches + ".error", "utf8").catch(() => "");
        throw new Error(`${opened.error.message}: ${diagnostic}`);
      }
      const session = opened.value;
      const output = session.outputs[Symbol.asyncIterator]();
      const request = {
        type: "turn.start" as const,
        input: [{ type: "text" as const, text }],
        turnId: hostTurnIdSchema.parse("turn-test"),
      };
      expect(await session.execute(request)).toMatchObject({ ok: true });
      await output.next();
      const terminal = (await output.next()).value;
      expect(await session.execute(request)).toMatchObject({ ok: false });
      await session.close();
      return { terminal, cleanup: await session.confirmNativeCleanup() };
    };
    expect(await run(a, "OK")).toMatchObject({
      terminal: { event: { billingSourceRef: a, outcome: { status: "succeeded" } } },
      cleanup: { ok: true, value: "not-persisted" },
    });
    expect(await run(b, "OK")).toMatchObject({
      terminal: { event: { billingSourceRef: b, outcome: { status: "succeeded" } } },
      cleanup: { ok: true, value: "not-persisted" },
    });
    expect(await run(a, "deny A")).toMatchObject({
      terminal: { event: { outcome: { status: "failed" } } },
      cleanup: { ok: true, value: "not-persisted" },
    });
    expect(await run(a, "reject before dispatch")).toMatchObject({
      terminal: { event: { outcome: { status: "failed" } } },
      cleanup: { ok: true, value: "not-persisted" },
    });
    expect(await run(b, "lose cleanup")).toMatchObject({
      terminal: { event: { billingSourceRef: b, outcome: { status: "succeeded" } } },
      cleanup: { ok: false },
    });
    const listed = await adapter.inspectAccounts();
    expect(JSON.stringify(listed)).not.toContain("native-");
    await writeFile(identities, JSON.stringify({ 11: "native-replacement" }), "utf8");
    const replacement = (await adapter.inspectAccounts())[0]?.billingSourceRef;
    expect(replacement).toBeDefined();
    expect(replacement).not.toEqual(a);
    if (!replacement) throw new Error("Expected a replacement Billing Source");
    expect(await adapter.openBillingSource({ ...create, billingSourceRef: a })).toMatchObject({
      ok: false,
    });
    expect(await run(replacement, "OK")).toMatchObject({
      terminal: { event: { billingSourceRef: replacement, outcome: { status: "succeeded" } } },
      cleanup: { ok: true, value: "not-persisted" },
    });
    expect(await run(replacement, "swap slot")).toMatchObject({
      terminal: { event: { outcome: { status: "failed" } } },
      cleanup: { ok: true, value: "not-persisted" },
    });
    expect((await readFile(launches, "utf8")).trim().split("\n")).toEqual([
      "11:native-11",
      "22:native-22",
      "22:native-22",
      "11:native-replacement",
      "11:native-replacement",
    ]);
  } finally {
    await adapter.close();
    await otherProfile.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

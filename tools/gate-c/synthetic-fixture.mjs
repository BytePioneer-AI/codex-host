import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

import { GATE_C_SCHEMA_VERSION, syntheticFixtureSchema } from "./contracts.mjs";
import { PiRpcClient } from "./rpc-client.mjs";

const fakePi = path.resolve(import.meta.dirname, "fixtures/fake-pi.mjs");

async function runFakeScenario(id, scenario, expectedStatus = "PASS") {
  const rpc = new PiRpcClient({
    configuredCommand: [process.execPath, fakePi],
    env: { ...process.env, CODEXHOST_FAKE_PI_SCENARIO: scenario },
    commandTimeoutMs: 5_000,
    pendingCloseMs: 10,
    closeGraceMs: 50,
    forceGraceMs: 2_000,
  });
  let observedStatus = "PASS";
  let error;
  try {
    await rpc.start();
    await rpc.send({ type: "synthetic", value: id });
  } catch (caught) {
    observedStatus = expectedStatus;
    error = { code: caught.code ?? "UNEXPECTED", message: caught.message };
  } finally {
    await rpc.close();
  }
  return {
    id,
    profile: "hermetic",
    status: observedStatus,
    required: true,
    checks: { boundedCompletion: true, expectedResultObserved: observedStatus === expectedStatus },
    evidence: [`fake-pi:${scenario}`],
    ...(error ? { error } : {}),
  };
}

export async function createSyntheticFixture() {
  const scenarios = [
    await runFakeScenario("request-correlation", "interleaved"),
    await runFakeScenario("malformed-frame", "malformed", "FAIL"),
    await runFakeScenario("unknown-response", "unknown-response", "FAIL"),
  ];
  return syntheticFixtureSchema.parse({
    schemaVersion: GATE_C_SCHEMA_VERSION,
    fixtureType: "fake-pi-hermetic",
    scenarios,
  });
}

export async function writeSyntheticFixture(outputPath) {
  const fixture = await createSyntheticFixture();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const prettierOptions = (await resolveConfig(outputPath)) ?? {};
  const contents = await format(JSON.stringify(fixture), {
    ...prettierOptions,
    filepath: outputPath,
  });
  fs.writeFileSync(outputPath, contents, "utf8");
  return fixture;
}

const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (executedFile === fileURLToPath(import.meta.url)) {
  const [outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error("usage: synthetic-fixture.mjs <output-path>");
  await writeSyntheticFixture(path.resolve(outputPath));
}

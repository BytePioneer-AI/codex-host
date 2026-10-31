import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  readHarnessDisplayEntries,
  withHarnessDisplayOrder,
} from "../src/harness-display-order.ts";

it("reads Desktop order without writing it and preserves model defaults and failures", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "harness-display-order-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "harness-display-settings-v1.json");
  const original = JSON.stringify([
    { agent: "grok", section: "main" },
    { agent: "pi", section: "auto" },
    { agent: "claude-code", section: "auto" },
  ]);
  writeFileSync(path, original);
  const selection = { provider: "claude-code", model: "original-default" };
  const failure = { id: "pi", name: "Pi", message: "Authentication required" };
  const result = withHarnessDisplayOrder(
    {
      default: selection,
      groups: [
        { id: "claude-code", name: "Claude Code", models: [] },
        { id: "codex", name: "Codex", models: [] },
        { id: "grok", name: "Grok", models: [] },
      ],
      failures: [failure],
    },
    await readHarnessDisplayEntries(directory),
  );
  assert.deepEqual(result.harnessOrder, ["codex", "grok", "pi", "claude-code"]);
  assert.deepEqual(
    result.groups.map((item) => item.id),
    ["codex", "grok", "claude-code"],
  );
  assert.equal(result.default, selection);
  assert.equal(result.failures[0], failure);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.deepEqual(await readHarnessDisplayEntries(join(directory, "missing")), []);
});

it("leads with the installed Codex CLI, as Desktop leads with official Codex", () => {
  const entries = [
    { agent: "grok", section: "main" as const },
    { agent: "pi", section: "auto" as const },
  ];
  const result = withHarnessDisplayOrder(
    {
      groups: [
        { id: "grok", name: "Grok" },
        { id: "codex-cli", name: "Codex CLI" },
        { id: "pi", name: "Pi" },
      ],
      failures: [],
    },
    entries,
  );
  assert.deepEqual(result.harnessOrder, ["codex-cli", "grok", "pi"]);
  assert.deepEqual(
    result.groups.map((item) => item.id),
    ["codex-cli", "grok", "pi"],
  );
  const missing = withHarnessDisplayOrder(
    {
      groups: [
        { id: "grok", name: "Grok" },
        { id: "pi", name: "Pi" },
      ],
      failures: [],
    },
    entries,
  );
  assert.deepEqual(missing.harnessOrder, ["grok", "pi"]);
});

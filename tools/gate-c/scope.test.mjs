import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const gateRoot = import.meta.dirname;

function allSource() {
  return fs
    .readdirSync(gateRoot, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /\.(mjs|ts)$/u.test(entry.name) && entry.name !== "scope.test.mjs",
    )
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("Gate C implementation boundary", () => {
  it("does not import Pi SDK, ACP, TUI, or invoke version detection", () => {
    const source = allSource();
    expect(source).not.toMatch(/from\s+["']@earendil-works\/pi-/u);
    expect(source).not.toMatch(
      /agentclientprotocol|--version|--mode["'],\s*["'](?:json|print)|\bACP\b/u,
    );
  });
});

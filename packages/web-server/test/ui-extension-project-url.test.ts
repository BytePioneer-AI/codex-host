import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { extensionProjectUrl } from "../src/ui-extension-project-url.ts";

const cases: { name: string; source: string; manifest: unknown; expected?: string }[] = [
  {
    name: "GitHub install source takes priority over a homepage",
    source: "https://github.com/author/theme.git#abc123",
    manifest: { homepage: "https://theme.example/" },
    expected: "https://github.com/author/theme",
  },
  ...[
    "git+https://github.com/author/theme.git",
    "github:author/theme",
    "git@github.com:author/theme.git",
    "git+ssh://git@github.com/author/theme.git",
    "git://github.com/author/theme.git",
  ].map((repository) => ({
    name: `npm repository ${repository}`,
    source: "theme@1.0.0",
    manifest: { repository: { type: "git", url: repository }, homepage: "https://theme.example/" },
    expected: "https://github.com/author/theme",
  })),
  {
    name: "GitHub repository string takes priority over a non-GitHub source",
    source: "https://downloads.example/theme.tgz",
    manifest: { repository: "https://github.com/author/theme" },
    expected: "https://github.com/author/theme",
  },
  {
    name: "homepage is the generic web fallback",
    source: "theme",
    manifest: { homepage: "https://theme.example/docs" },
    expected: "https://theme.example/docs",
  },
  {
    name: "non-GitHub repository is a generic link",
    source: "theme",
    manifest: { repository: { url: "git+https://gitlab.com/author/theme.git" } },
    expected: "https://gitlab.com/author/theme.git",
  },
  {
    name: "a web install source works without a manifest",
    source: "https://github.com/author/theme#v1",
    manifest: null,
    expected: "https://github.com/author/theme",
  },
  ...["/Users/example/theme", "theme@1.0.0"].map((source) => ({
    name: `no address for ${source}`,
    source,
    manifest: {},
  })),
  ...[
    "javascript:alert(1)",
    "file:///Users/example/theme",
    "https://user:secret@theme.example/",
    "not a URL",
  ].map((homepage) => ({
    name: `reject unsafe or invalid address ${homepage}`,
    source: "theme",
    manifest: { homepage },
  })),
];

for (const { name, source, manifest, expected } of cases) {
  it(name, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "codexhost-extension-link-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    if (manifest !== null) writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
    assert.equal(extensionProjectUrl(directory, source), expected);
  });
}

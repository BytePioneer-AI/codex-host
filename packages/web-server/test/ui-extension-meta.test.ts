/** DSH metadata resources follow exports and never evaluate plugin JavaScript. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import { readExtensionMeta } from "../src/ui-extension-meta.ts";

const NAME = "@fixture/metadata";
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7"/></svg>';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codexhost-extension-meta-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "node_modules", NAME);
  const file = (name: string, text: string) => {
    const target = join(directory, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    return target;
  };
  const manifest = (extra: object = {}) =>
    file(
      "package.json",
      JSON.stringify({
        name: NAME,
        version: "1.0.0",
        type: "module",
        description: "Package summary",
        exports: {
          ".": "./index.js",
          "./package.json": "./package.json",
          "./locale/*.json": "./locale/*.json",
          "./icon": "./icon.svg",
        },
        ...extra,
      }),
    );
  const locale = (language: string, meta: unknown) =>
    file(`locale/${language}.json`, JSON.stringify({ meta }));
  manifest();
  file("index.js", 'throw new Error("Metadata must not execute plugin code");');
  return {
    root,
    directory,
    file,
    manifest,
    locale,
    read: () => readExtensionMeta(NAME, directory),
  };
}

it("reads localized fields independently with package and English fallbacks", (t) => {
  const f = fixture(t);
  f.locale("en", { title: "Clock" });
  f.locale("zh", { description: "桌面时钟" });
  f.locale("pt-BR", { title: "Relógio" });
  f.file("icon.svg", SVG);
  assert.deepEqual(f.read(), {
    title: { en: "Clock", "pt-br": "Relógio" },
    description: { en: "Package summary", zh: "桌面时钟" },
    icon: `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`,
  });
});

it("uses exported icons without requiring an exported manifest", (t) => {
  const f = fixture(t);
  f.manifest({ exports: { "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" } });
  f.locale("en", { title: "Whale", description: "A whale pet." });
  f.file("icon.svg", SVG);
  assert.equal(f.read()?.icon, `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`);
  assert.deepEqual(f.read()?.title, { en: "Whale" });
});

it("prefers a manifest icon and leaves missing translations to the technical-name fallback", (t) => {
  const f = fixture(t);
  f.manifest({ icon: "assets/icon.png" });
  f.file("assets/icon.png", "png image bytes");
  f.file("icon.svg", SVG);
  assert.deepEqual(f.read(), {
    title: NAME,
    description: "Package summary",
    icon: `data:image/png;base64,${Buffer.from("png image bytes").toString("base64")}`,
  });
});

it("ignores unexported metadata files and unexported package fields", (t) => {
  const f = fixture(t);
  f.manifest({ icon: "assets/icon.png", exports: { ".": "./index.js" } });
  f.file("assets/icon.png", "image");
  f.file("icon.svg", SVG);
  f.locale("en", { title: "Hidden" });
  assert.equal(f.read(), undefined);
});

it("supports import conditions and patterns in resource exports", (t) => {
  const f = fixture(t);
  f.manifest({
    exports: {
      "./package.json": "./package.json",
      "./locale/*.json": { import: "./translations/*.json", default: "./wrong/*.json" },
      "./icon": { import: "./images/icon.svg", default: "./missing.svg" },
    },
  });
  f.file("translations/en.json", JSON.stringify({ meta: { title: "Imported" } }));
  f.file("images/icon.svg", SVG);
  assert.deepEqual(f.read()?.title, { en: "Imported" });
  assert.ok(f.read()?.icon);
});

for (const icon of [
  "missing.png",
  "https://example.com/icon.svg",
  "/tmp/icon.svg",
  "C:\\icon.svg",
  "../outside.svg",
  "icon.gif",
  "large.svg",
  "folder",
]) {
  it(`keeps valid text and reports an invalid manifest icon: ${icon}`, (t) => {
    const f = fixture(t);
    f.manifest({ icon });
    f.locale("en", { title: "Valid title" });
    f.file("icon.svg", SVG);
    f.file("icon.gif", "gif");
    f.file("large.svg", " ".repeat(256 * 1024 + 1));
    mkdirSync(join(f.directory, "folder"));
    writeFileSync(join(dirname(f.directory), "outside.svg"), SVG);
    const meta = f.read();
    assert.deepEqual(meta?.title, { en: "Valid title" });
    assert.equal(meta?.icon, undefined, "an invalid declaration must not try the exported icon");
    assert.ok(meta?.error);
  });
}

it("rejects icon symlinks that leave the package", (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside.svg");
  writeFileSync(outside, SVG);
  symlinkSync(outside, join(f.directory, "icon.svg"));
  assert.equal(f.read()?.icon, undefined);
  assert.match(f.read()?.error ?? "", /inside its package/u);
  f.manifest({ icon: "icon.svg" });
  assert.match(f.read()?.error ?? "", /inside its manifest/u);
});

for (const content of ['{"meta":', '{"meta":{"title":""}}', '{"meta":{"description":42}}']) {
  it(`reports malformed locale metadata: ${content}`, (t) => {
    const f = fixture(t);
    f.file("locale/en.json", content);
    const meta = f.read();
    assert.ok(meta?.error);
    assert.equal(meta?.title, undefined);
  });
}

it("keeps a legacy package with no exports manageable", (t) => {
  const f = fixture(t);
  f.manifest({ exports: undefined });
  assert.deepEqual(f.read(), { title: NAME, description: "Package summary" });
});

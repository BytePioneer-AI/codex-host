// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { $getRoot, $isTextNode } from "lexical";
import { scanTextRefs } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/input/decorations.ts";
import { SessionInputShell } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/input/facade.ts";

const cases: Array<[string, string[]]> = [
  ["@src/a.ts", ["@src/a.ts"]],
  ['@"dir/a b.md"', ['@"dir/a b.md"']],
  ["@README.md", ["@README.md"]],
  [
    "@src/deep/file.txt， @src/.env @C:\\src\\a.ts @src/de",
    ["@src/deep/file.txt", "@src/.env", "@C:\\src\\a.ts", "@src/de"],
  ],
  ['@"/a/nv/SM100 ISA.html" 看 @"a/ b.md"。', ['@"/a/nv/SM100 ISA.html"', '@"a/ b.md"']],
  [
    '@"dir a/" @src/deep/。 @dir/ 请看 @"src/"，然后 @"open dir/ x',
    ['@"dir a/"', "@src/deep/", "@dir/", '@"src/"', '@"open dir/'],
  ],
  ['@person @"" @"a/b', []],
  ['@"open @', []],
  ['drill @"open dir/。', ['@"open dir/']],
  ["@src/a.ts.,;:!?，。；：！？", ["@src/a.ts"]],
  ["@person。 x@src/a.ts person@example.com", []],
  ["@src/a.ts\n@README.md", ["@src/a.ts", "@README.md"]],
];

it.each(cases)("scans whole path tokens in %j", (text, expected) => {
  expect(scanTextRefs(text, new Map()).map((range) => text.slice(range.start, range.end))).toEqual(
    expected,
  );
});

it("preserves lexicon references and slash-command boundaries", () => {
  const text = "/plan /plan.md /plan。 /plan/x @person @README.md";
  expect(
    scanTextRefs(
      text,
      new Map([
        ["/", ["plan"]],
        ["@", ["person"]],
      ]),
    ).map((range) => text.slice(range.start, range.end)),
  ).toEqual(["/plan", "@person", "@README.md"]);
});

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

it("decorates the complete pasted path without changing draft text or making it atomic", () => {
  const input = new SessionInputShell({
    actx: {} as never,
    defaultSink: async () => ({ kind: "success" }),
    commandAttachments: {
      serialize: async () => [],
      release: () => {},
      unsupportedNotice: () => "unsupported",
    },
  });
  const root = document.createElement("div");
  document.body.append(root);
  input.editor.setRootElement(root);
  cleanup.push(() => {
    input.editor.setRootElement(null);
    input.dispose();
    root.remove();
  });
  const text = '@src/a.ts @"dir/a b.md" @README.md';
  input.actions.setDraft(text);
  expect(input.snapshot.draft).toBe(text);
  expect(input.snapshot.occurrences).toEqual([]);
  expect(
    [...root.querySelectorAll("[data-composer-text-ref]")].map((node) => node.textContent),
  ).toEqual(["@src/a.ts", '@"dir/a b.md"', "@README.md"]);
  input.editor.update(
    () => {
      const path = $getRoot().getFirstDescendant();
      if (!$isTextNode(path)) throw new Error("missing path token");
      path.setTextContent("@person");
    },
    { discrete: true },
  );
  expect(input.snapshot.draft).toBe('@person @"dir/a b.md" @README.md');
  expect(
    [...root.querySelectorAll("[data-composer-text-ref]")].map((node) => node.textContent),
  ).toEqual(['@"dir/a b.md"', "@README.md"]);
});

// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionInputShell } from "../../../apps/web-ui/packages/client/ui-conversation/src/client/input/facade.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

/** One shell whose sink resolves on demand, plus the prompt texts it received. */
function fixture(sinkResult: () => Promise<{ kind: "success" } | { kind: "error"; text: string }>) {
  const sent: Array<{ text: string; attachments: readonly string[] }> = [];
  const shell = new SessionInputShell({
    actx: {} as never,
    defaultSink: (text, attachmentIds) => {
      sent.push({ text, attachments: attachmentIds });
      return sinkResult();
    },
  });
  cleanup.push(() => {
    shell.dispose();
  });
  return { shell, sent };
}

/** Prompts Codex Desktop composes for the same cases, from its own assembly. */
const GOLDEN = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../../packages/shared-contracts/test/fixtures/desktop-annotations.json",
    ),
    "utf8",
  ),
) as { readonly cases: readonly { readonly name: string; readonly desktop: string }[] };

function desktopPrompt(name: string): string {
  const found = GOLDEN.cases.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing Desktop case ${name}`);
  return found.desktop;
}

it("sends attached annotations as the message prefix", async () => {
  const { shell, sent } = fixture(async () => ({ kind: "success" }));
  shell.addResponseAnnotation({ text: "  keep the drain loop  " });
  shell.actions.setDraft("  Explain why.  ");
  shell.submit("queue", "click");
  await vi.waitFor(() => expect(sent.length).toBe(1));
  // Byte for byte the prompt the installed Desktop composes for these inputs.
  expect(sent[0]?.text).toBe(desktopPrompt("single"));
});

it("sends an annotation-only message and clears it on success", async () => {
  const { shell, sent } = fixture(async () => ({ kind: "success" }));
  shell.addResponseAnnotation({ text: "keep the drain loop" });
  expect(shell.snapshot.responseAnnotations).toHaveLength(1);
  shell.submit("queue", "click");
  await vi.waitFor(() => expect(sent.length).toBe(1));
  expect(sent[0]?.text).toBe(desktopPrompt("annotation only"));
  await vi.waitFor(() => expect(shell.snapshot.responseAnnotations).toHaveLength(0));
});

it("keeps annotations in attachment order and drops a removed one", () => {
  const { shell } = fixture(async () => ({ kind: "success" }));
  const first = shell.addResponseAnnotation({ text: "one" });
  const second = shell.addResponseAnnotation({ text: "two" });
  expect(shell.snapshot.responseAnnotations.map((entry) => entry.text)).toEqual(["one", "two"]);
  if (first === undefined || second === undefined) throw new Error("annotation ids missing");
  expect(shell.removeResponseAnnotation(first)).toBe(true);
  expect(shell.snapshot.responseAnnotations.map((entry) => entry.text)).toEqual(["two"]);
  expect(shell.removeResponseAnnotation(first)).toBe(false);
});

it("restores annotations and text when the send fails", async () => {
  let fail = true;
  const { shell } = fixture(async () =>
    fail ? { kind: "error", text: "send failed" } : { kind: "success" },
  );
  shell.addResponseAnnotation({ text: "keep this" });
  shell.actions.setDraft("body");
  shell.submit("queue", "click");
  await vi.waitFor(() => expect(shell.snapshot.draft).toBe("body"));
  expect(shell.snapshot.responseAnnotations.map((entry) => entry.text)).toEqual(["keep this"]);
  fail = false;
});

it("carries an annotation added during a send into the next message", async () => {
  const pending = Promise.withResolvers<{ kind: "success" }>();
  const { shell, sent } = fixture(() => pending.promise);
  shell.addResponseAnnotation({ text: "first" });
  shell.actions.setDraft("first body");
  shell.submit("queue", "click");
  await flush();
  // The send already claimed the attached annotations; a new one belongs to
  // the next message instead of joining the message in flight.
  expect(shell.addResponseAnnotation({ text: "second" })).toBeDefined();
  pending.resolve({ kind: "success" });
  await vi.waitFor(() => expect(sent.length).toBe(1));
  expect(sent[0]?.text).toContain('"first"');
  expect(sent[0]?.text).not.toContain('"second"');
  expect(shell.snapshot.responseAnnotations.map((entry) => entry.text)).toEqual(["second"]);
});

it("does not bring back an annotation removed from a restored failure", async () => {
  // Two sends in flight: the first failure is restored, the user drops its
  // annotation, and the second failure must not rebuild it from its own record.
  const first = Promise.withResolvers<{ kind: "error"; text: string }>();
  const second = Promise.withResolvers<{ kind: "error"; text: string }>();
  let calls = 0;
  const { shell } = fixture(() => (++calls === 1 ? first.promise : second.promise));
  const attached = shell.addResponseAnnotation({ text: "first" });
  if (attached === undefined) throw new Error("annotation id missing");
  shell.actions.setDraft("first body");
  shell.submit("queue", "click");
  await vi.waitFor(() => expect(calls).toBe(1));
  shell.addResponseAnnotation({ text: "second" });
  shell.actions.setDraft("second body");
  shell.submit("queue", "click");
  await vi.waitFor(() => expect(calls).toBe(2));
  first.resolve({ kind: "error", text: "failed A" });
  await vi.waitFor(() =>
    expect(shell.snapshot.responseAnnotations.map((a) => a.text)).toEqual(["first"]),
  );
  expect(shell.removeResponseAnnotation(attached)).toBe(true);
  expect(shell.snapshot.responseAnnotations).toEqual([]);
  second.resolve({ kind: "error", text: "failed B" });
  await vi.waitFor(() => expect(shell.snapshot.responseAnnotations).toHaveLength(1));
  expect(shell.snapshot.responseAnnotations.map((a) => a.text)).toEqual(["second"]);
});

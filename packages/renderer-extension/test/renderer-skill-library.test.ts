// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  desktopSkillMentionPath,
  formatSkillReference,
  harnessCommandDescriptorSchema,
  type SkillsChangedParams,
} from "@codexhost/shared-contracts";
import { installRendererDelegationMention } from "../src/renderer-delegation-mention.js";
import { createRendererSkillLibrary } from "../src/renderer-skill-library.js";
import { createRendererModelClient } from "../src/renderer-model-client.js";

const skill = {
  name: "eli5",
  description: "Explain networking",
  path: "/skills/SKILL.md",
  source: "Agents",
  scope: "global" as const,
};
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function editor(text: string) {
  const element = document.createElement("div");
  element.contentEditable = "true";
  element.setAttribute("contenteditable", "true");
  element.textContent = text;
  document.body.append(element);
  const node = element.firstChild as Text;
  const selection = document.getSelection();
  if (!selection) throw new Error("Missing selection");
  selection.setBaseAndExtent(node, text.length, node, text.length);
  return { element, node };
}

it("groups Skills separately from commands and inserts their carrier using the native controller", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const { element, node } = editor("before #eli5");
  const insert = vi.fn();
  const nodeType = {};
  Object.assign(element, {
    __reactFiber$skill: {
      memoizedProps: {
        composerController: {
          view: {
            dom: element,
            posAtDOM: (_node: Node, offset: number) => offset,
            state: {
              schema: { nodes: { agentMention: nodeType } },
              doc: { textBetween: (a: number, b: number) => node.data.slice(a, b) },
            },
          },
          insertMentionNodeInRange: insert,
        },
      },
    },
  });
  const menu = installRendererDelegationMention(document, {
    readTargets: () => [],
    isComposerEditor: () => true,
    readLocale: () => "en",
    anchorForEditor: () => element,
    readCommands: () => ({
      commands: [
        harnessCommandDescriptorSchema.parse({
          id: "test",
          invocation: "/eli5-command",
          label: "Eli5 command",
          argumentMode: "none",
        }),
      ],
      disabledReason: () => null,
      select: vi.fn(),
    }),
    readSkills: () => ({ skills: [skill], warning: "Unreadable test", retry: () => {} }),
  });
  disposers.push(() => menu.dispose());
  element.dispatchEvent(new Event("input", { bubbles: true }));
  const root = document.querySelector("[data-codexhost-delegation-mention-menu]");
  if (!root) throw new Error("Missing menu");
  expect(root.textContent).toContain("Commands");
  expect(root.textContent).toContain("Skills");
  expect(root.querySelector('[aria-disabled="true"]')?.textContent).toContain(
    "Some Skills could not be read",
  );
  expect(root.textContent).toContain("Global · Agents · /skills/SKILL.md");
  const option = root.querySelector("[data-skill-path]")?.closest('[role="option"]');
  if (!(option instanceof HTMLElement)) throw new Error("Missing Skill option");
  option.click();
  await vi.waitFor(() =>
    expect(insert).toHaveBeenCalledWith(
      nodeType,
      {
        conversationId: null,
        name: "eli5",
        displayName: "eli5",
        path: desktopSkillMentionPath(skill),
      },
      7,
      12,
      true,
    ),
  );
  expect(formatSkillReference(skill)).toBe('[$eli5](/skills/SKILL.md "Read this skill")');
});

it("uses one snapshot while searching, refreshes notifications and releases listeners on close", async () => {
  const request = vi.fn(async () => ({ revision: 1, complete: true, skills: [skill] }));
  let notify: ((value: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const client = createRendererModelClient([
    {
      sendRequest: request,
      addNotificationCallback: (_method: unknown, cb: (value: unknown) => void) => {
        notify = cb;
        return unsubscribe;
      },
    },
  ]);
  if (!client) throw new Error("Missing client");
  const { element } = editor("#");
  const changed = vi.fn();
  const library = createRendererSkillLibrary({
    context: () => ({ client, params: { cwd: "/workspace" } }),
    locale: () => "en",
    changed,
  });
  disposers.push(() => library.dispose());
  library.open(element);
  await vi.waitFor(() => expect(library.read(element)?.skills).toEqual([skill]));
  library.open(element);
  library.read(element);
  expect(request).toHaveBeenCalledTimes(1);
  const change = (params: SkillsChangedParams) =>
    notify?.({ method: "codexhost/skills/changed", params });
  change({ cwd: "/other" });
  expect(request).toHaveBeenCalledTimes(1);
  change({});
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[0]?.slice(0, 2)).toEqual([
    "codexhost/skills/list",
    { cwd: "/workspace" },
  ]);
  library.close();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("does not query when the context provider rejects a Composer", () => {
  const { element } = editor("#");
  const library = createRendererSkillLibrary({
    context: () => null,
    locale: () => "en",
    changed: vi.fn(),
  });
  library.open(element);
  expect(library.read(element)).toBeNull();
  library.dispose();
});

it("retains an in-flight workspace query when the same draft replaces its editor", async () => {
  const gate = Promise.withResolvers<{
    revision: number;
    complete: boolean;
    skills: (typeof skill)[];
  }>();
  const request = vi.fn(() => gate.promise);
  const client = createRendererModelClient([{ sendRequest: request }]);
  if (!client) throw new Error("Missing client");
  const first = editor("#").element;
  const library = createRendererSkillLibrary({
    context: (element) => (element.isConnected ? { client, params: {} } : null),
    locale: () => "en",
    changed: vi.fn(),
  });
  disposers.push(() => library.dispose());
  library.open(first);
  first.remove();
  const replacement = editor("#").element;
  library.open(replacement);
  gate.resolve({ revision: 1, complete: true, skills: [skill] });
  await vi.waitFor(() => expect(library.read(replacement)?.skills).toEqual([skill]));
  expect(request).toHaveBeenCalledOnce();
});

it("keeps RPC errors retryable and scan warnings non-selectable", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      revision: 2,
      complete: true,
      skills: [skill],
      warnings: ["bad frontmatter"],
    });
  const client = createRendererModelClient([{ sendRequest: request }]);
  if (!client) throw new Error("Missing client");
  const { element } = editor("#");
  const library = createRendererSkillLibrary({
    context: () => ({ client, params: {} }),
    locale: () => "en",
    changed: vi.fn(),
  });
  disposers.push(() => library.dispose());
  library.open(element);
  await vi.waitFor(() => expect(library.read(element)?.error).toBe("offline"));
  library.read(element)?.retry();
  await vi.waitFor(() => expect(library.read(element)?.warning).toBe("bad frontmatter"));
  expect(library.read(element)?.error).toBeUndefined();
});

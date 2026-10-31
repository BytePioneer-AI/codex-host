// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { $getRoot, $createRangeSelection, $setSelection, KEY_ENTER_COMMAND } from "lexical";
import { SessionInputShell } from "../../apps/web-ui/packages/client/ui-conversation/src/client/input/facade.ts";
import { InputBar } from "../../apps/web-ui/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx";

vi.mock(
  "../../apps/web-ui/packages/client/ui-conversation/src/client/input/editor/DraftEditor.tsx",
  () => ({
    DraftEditor: () => null,
  }),
);
vi.mock(
  "../../apps/web-ui/packages/client/ui-conversation/src/client/input/editor/view-binding.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/web-ui/packages/client/ui-conversation/src/client/input/editor/view-binding.ts")
    >()),
    focusDraftEditor: vi.fn(),
    installDraftFilePicker: vi.fn(),
    installDraftWheel: vi.fn(),
    keepDraftFocus: vi.fn(),
    revealDraftSelection: vi.fn(),
  }),
);

vi.mock(
  "../../apps/web-ui/packages/client/ui-conversation/src/client/skeleton/control-row-layout.ts",
  () => ({
    observeControlRow: vi.fn(),
  }),
);

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

function shell() {
  const input = new SessionInputShell({
    actx: {} as never,
    defaultSink: vi.fn(async () => ({ kind: "success" as const })),
    commandAttachments: {
      serialize: async () => [],
      release: () => {},
      unsupportedNotice: () => "unsupported",
    },
  });
  cleanup.push(() => input.dispose());
  return input;
}

it("captures the document end without replacing a selected prefix or changing the revision", () => {
  const input = shell();
  input.actions.setDraft("已有文字");
  input.editor.update(
    () => {
      const text = $getRoot().getFirstDescendant()!;
      const selection = $createRangeSelection();
      selection.anchor.set(text.getKey(), 0, "text");
      selection.focus.set(text.getKey(), 2, "text");
      $setSelection(selection);
    },
    { discrete: true },
  );
  const revision = input.snapshot.draftRev;
  expect(input.actions.captureInsertion()).toMatchObject({ start: 0, end: 2 });
  const end = input.actions.captureInsertion("end");
  expect(end).toEqual({ start: 4, end: 4, draftRev: revision });
  expect(input.actions.insertText("录音文字", end)).toBe(true);
  expect(input.snapshot.draft).toBe("已有文字录音文字");
});

it("appends after reference chips without flattening them or removing attachments", () => {
  const input = shell();
  input.actions.setDraft("查看 ");
  expect(
    input.insertReference(
      {
        source: "file",
        ref: "README.md",
        label: "README.md",
        clipboardText: "@README.md",
      },
      input.actions.captureInsertion("end"),
    ),
  ).toBe(true);
  input.actions.addAttachments(["image-a"]);
  const references = input.snapshot.occurrences;
  const end = input.actions.captureInsertion("end");
  expect(end.end).toBeLessThan(input.snapshot.draft.length);
  const before = input.snapshot.draft;
  expect(input.actions.insertText("补充说明", end)).toBe(true);
  expect(input.snapshot.draft).toBe(`${before}补充说明`);
  expect(input.snapshot.occurrences).toEqual(references);
  expect(input.snapshot.attachmentIds).toEqual(["image-a"]);
});

async function renderBar(
  input: SessionInputShell,
  running = false,
  overrides: Partial<ComponentProps<typeof InputBar>> = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup.unshift(() => {
    act(() => root.unmount());
    container.remove();
  });
  const stop = vi.fn();
  const submit = vi.fn();
  const keyboard = {
    editor: input.editor,
    submit,
    arbitrate: vi.fn((): "pass" | "consumed" => "pass"),
    dismissPopup: vi.fn(),
    space: vi.fn(() => false),
    steerQueue: vi.fn(),
    paste: vi.fn(),
  };
  const props = {
    sessionId: "thread-a",
    useInput: (select: (state: typeof input.snapshot) => unknown) =>
      select(useSyncExternalStore(input.state.subscribe, input.state.getSnapshot)),
    inputActions: input.actions,
    keyboard,
    useSession: (select: (state: object) => unknown) => select({ running, removed: false }),
    useBusyEnter: (select: (value: string) => unknown) => select("queue"),
    useFileUploads: (select: (value: object) => unknown) => select({}),
    useNotices: (select: (value: null) => unknown) => select(null),
    useMenuLauncher: (select: (value: undefined) => unknown) => select(undefined),
    useStopShortcut: (select: (value: string[]) => unknown) => select([]),
    useProjection: () => undefined,
    resolveDraftAttachments: () => [],
    renderSlot: () => null,
    stop,
    t: (key: string) => key,
    ...overrides,
  } as unknown as ComponentProps<typeof InputBar>;
  await act(async () => root.render(createElement(InputBar, props)));
  const primary = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="input.send"]')!;
  const enter = async (options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, ...options });
    await act(async () => {
      input.editor.dispatchCommand(KEY_ENTER_COMMAND, event);
    });
    return event;
  };
  return { primary, stop, submit, keyboard, enter };
}

it.each([false, true])(
  "uses the temporary send for an empty draft even when running=%s, and restores default behavior",
  async (running) => {
    const input = shell();
    const run = vi.fn();
    const release = input.actions.bindPrimaryAction({ disabled: false, run });
    const { primary, stop, submit } = await renderBar(input, running);
    expect(primary().disabled).toBe(false);
    await act(async () => primary().click());
    expect(run).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => release());
    expect(input.snapshot.primaryAction).toBeUndefined();
    if (running) expect(primary()).toBeNull();
    else expect(primary().disabled).toBe(true);
  },
);

it("does not send the existing draft while the temporary action is transcribing", async () => {
  const input = shell();
  input.actions.setDraft("已有文字");
  const run = vi.fn();
  const release = input.actions.bindPrimaryAction({ disabled: true, run });
  const { primary, submit } = await renderBar(input);
  expect(primary().disabled).toBe(true);
  await act(async () => primary().click());
  expect(run).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  await act(async () => release());
  expect(primary().disabled).toBe(false);
  await act(async () => primary().click());
  expect(submit).toHaveBeenCalledOnce();
});

it.each(["", "已有文字"])(
  "Enter uses the recording send for draft %j before menu arbitration",
  async (draft) => {
    const input = shell();
    input.actions.setDraft(draft);
    const run = vi.fn();
    input.actions.bindPrimaryAction({ disabled: false, run });
    const { enter, keyboard, submit } = await renderBar(input);
    keyboard.arbitrate.mockReturnValue("consumed");
    const event = await enter();
    expect(event.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(keyboard.arbitrate).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  },
);

it.each([{ ctrlKey: true }, { metaKey: true }])(
  "modified Enter sends the recording instead of steering the queue: %j",
  async (options) => {
    const input = shell();
    const run = vi.fn();
    input.actions.bindPrimaryAction({ disabled: false, run });
    input.state.set({ ...input.snapshot, queue: [{} as never] });
    const { enter, keyboard, submit } = await renderBar(input, true);
    await enter(options);
    expect(run).toHaveBeenCalledOnce();
    expect(keyboard.steerQueue).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  },
);

it.each([{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }])(
  "does not send a recording on a newline, composition confirmation, or repeated Enter: %j",
  async (options) => {
    const input = shell();
    const run = vi.fn();
    input.actions.bindPrimaryAction({ disabled: false, run });
    const { enter, submit } = await renderBar(input);
    await enter(options);
    expect(run).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  },
);

it("blocks Enter during permission/transcription, then restores normal Enter on release", async () => {
  const input = shell();
  input.actions.setDraft("已有文字");
  const run = vi.fn();
  const release = input.actions.bindPrimaryAction({ disabled: true, run });
  const { enter, keyboard, submit } = await renderBar(input);
  await enter();
  expect(run).not.toHaveBeenCalled();
  expect(keyboard.arbitrate).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  await act(async () => release());
  await enter();
  expect(keyboard.arbitrate).toHaveBeenCalledWith("enter", false);
  expect(submit).toHaveBeenCalledWith("queue", "enter");
});

it("does not send a recording with Enter when the composer is blocked", async () => {
  const input = shell();
  const run = vi.fn();
  input.actions.bindPrimaryAction({ disabled: false, run });
  const { enter, submit } = await renderBar(input, false, { blocked: { reason: "blocked" } });
  await enter();
  expect(run).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it("does not let a stale primary-action disposer clear a newer binding", () => {
  const input = shell();
  const release = input.actions.bindPrimaryAction({ disabled: false, run: vi.fn() });
  const latest = { disabled: true, run: vi.fn() };
  const releaseLatest = input.actions.bindPrimaryAction(latest);
  release();
  expect(input.snapshot.primaryAction).toBe(latest);
  releaseLatest();
  expect(input.snapshot.primaryAction).toBeUndefined();
});

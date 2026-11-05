import { describe, expect, it, vi } from "vitest";
import {
  readNativeScheduleForm,
  nativeScheduleModelRows,
} from "../src/renderer-native-schedule-form.js";

function fixture() {
  let draft = {
    id: null as string | null,
    kind: "heartbeat",
    prompt: "Task instructions",
    model: "gpt-native",
    reasoningEffort: "high",
    targetThreadId: null as string | null,
    scheduleConfig: { mode: "weekly", weekdays: [1, 3], time: "13:15" },
    scheduleDirty: true,
    notificationPolicy: "important",
  };
  const onChange = vi.fn((update: (current: typeof draft) => typeof draft) => {
    draft = update(draft);
    props.draft = draft;
  });
  const props = {
    setup: { triggerMode: "create" },
    draft,
    executionLocation: "local",
    isSaving: false,
    onChange,
    onSubmit: vi.fn(),
  };
  const owner = { memoizedProps: props, return: null as unknown };
  const form = { __reactFiber$test: { memoizedProps: {}, return: owner } };
  return { form, props, owner, onChange, draft: () => draft };
}

describe("native scheduled task creation binding", () => {
  it("changes only the new task Model and preserves native recurrence and notification fields", () => {
    const f = fixture();
    const binding = readNativeScheduleForm(f.form);
    if (!binding) throw new Error("Native schedule binding missing");
    const before = f.draft();
    expect(binding.supportsExternal).toBe(true);
    binding.setModel({ model: "codexhost/example", reasoningEffort: null });
    expect(f.draft()).toEqual({ ...before, model: "codexhost/example", reasoningEffort: null });
    expect(f.props.onSubmit).not.toHaveBeenCalled();
    expect(before.model).toBe("gpt-native");
  });

  it("attaches a confirmed chat only to the matching external task draft", () => {
    const f = fixture();
    const model = "codexhost/plugin-v1@7069";
    f.props.draft.model = model;
    const before = { ...f.draft() };
    const binding = readNativeScheduleForm(f.form);
    if (!binding) throw new Error("Native schedule binding missing");
    expect(binding.title).toBe("Task instructions");
    binding.setTargetThread("prepared-thread", model);
    expect(f.draft()).toEqual({ ...before, targetThreadId: "prepared-thread" });
    expect(readNativeScheduleForm(f.form)?.targetThreadId).toBe("prepared-thread");
    expect(f.props.onSubmit).not.toHaveBeenCalled();
  });

  it("cannot attach a workspace chat to Codex, a changed Model or a saving task", () => {
    const f = fixture();
    readNativeScheduleForm(f.form)?.setTargetThread("thread", "gpt-native");
    expect(f.onChange).not.toHaveBeenCalled();
    const model = "codexhost/plugin-v1@7069";
    f.props.draft.model = model;
    const binding = readNativeScheduleForm(f.form);
    if (!binding) throw new Error("Native schedule binding missing");
    f.props.draft.model = "gpt-native";
    binding.setTargetThread("thread", model);
    expect(f.draft().targetThreadId).toBeNull();
    f.props.draft.model = model;
    f.props.isSaving = true;
    readNativeScheduleForm(f.form)?.setTargetThread("thread", model);
    expect(f.draft().targetThreadId).toBeNull();
  });

  it("keeps Codex, cloud, cron and goal semantics distinct", () => {
    const f = fixture();
    expect(f.onChange).not.toHaveBeenCalled();
    f.props.executionLocation = "cloud";
    expect(readNativeScheduleForm(f.form)?.supportsExternal).toBe(false);
    f.props.executionLocation = "local";
    f.props.draft.kind = "cron";
    expect(readNativeScheduleForm(f.form)?.supportsExternal).toBe(false);
    f.props.draft.kind = "heartbeat";
    Object.assign(f.props, { creation: { type: "goal" } });
    expect(readNativeScheduleForm(f.form)?.supportsExternal).toBe(false);
  });

  it("does not bind edits, unrelated forms, ambiguous owners or changed contracts", () => {
    const f = fixture();
    f.props.draft.id = "saved";
    expect(readNativeScheduleForm(f.form)).toBeNull();
    f.props.draft.id = null;
    f.props.setup.triggerMode = "edit";
    expect(readNativeScheduleForm(f.form)).toBeNull();
    f.props.setup.triggerMode = "create";
    f.owner.return = { memoizedProps: { ...f.props, onChange: vi.fn() } };
    expect(readNativeScheduleForm(f.form)).toBeNull();
    f.owner.return = { memoizedProps: f.props };
    expect(readNativeScheduleForm(f.form)).not.toBeNull();
    expect(readNativeScheduleForm({})).toBeNull();
  });

  it("never changes the Harness of an already created target or a saving task", () => {
    const f = fixture();
    f.props.draft.targetThreadId = "thread";
    const binding = readNativeScheduleForm(f.form);
    if (!binding) throw new Error("Native schedule binding missing");
    expect(binding.hasTarget).toBe(true);
    binding.setModel({ model: "other", reasoningEffort: null });
    expect(f.onChange).not.toHaveBeenCalled();
    f.props.draft.targetThreadId = null;
    f.props.isSaving = true;
    readNativeScheduleForm(f.form)?.setModel({ model: "other", reasoningEffort: null });
    expect(f.onChange).not.toHaveBeenCalled();
  });

  it("uses committed props when the form points at the alternate React tree", () => {
    const f = fixture();
    const currentOwner = {
      memoizedProps: { ...f.props, executionLocation: "cloud" },
      return: null as unknown,
      child: null as unknown,
    };
    const currentForm = {
      memoizedProps: {},
      return: currentOwner,
      alternate: f.form.__reactFiber$test,
    };
    currentOwner.child = currentForm;
    const root = { child: currentOwner, stateNode: { current: null as unknown } };
    root.stateNode.current = root;
    currentOwner.return = root;
    f.owner.return = { stateNode: root.stateNode };
    Object.assign(f.form.__reactFiber$test, { alternate: currentForm });
    expect(readNativeScheduleForm(f.form)?.supportsExternal).toBe(false);
  });

  it("finds only semantic Codex Model/Effort rows, without matching translated text", () => {
    const row = {
      nodeType: 1,
      hidden: false,
      style: { getPropertyValue: () => "", getPropertyPriority: () => "", setProperty: vi.fn() },
    };
    const unrelated = { nodeType: 1, hidden: false };
    const button = {
      __reactFiber$test: {
        stateNode: {},
        return: {
          stateNode: row,
          return: { memoizedProps: { label: { props: { id: "inbox.automations.model.label" } } } },
        },
      },
    };
    const form = {
      querySelectorAll: () => [button],
      contains: (node: unknown) => node === row || node === unrelated,
    };
    expect(nativeScheduleModelRows(form)).toEqual([row]);
    expect(row.hidden).toBe(false);
  });
});

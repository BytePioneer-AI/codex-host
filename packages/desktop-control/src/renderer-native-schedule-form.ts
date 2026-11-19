import { committedReactAncestors } from "./renderer-react-ownership.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface NativeScheduleModel {
  model: string | null;
  reasoningEffort: string | null;
}
export interface NativeScheduleForm {
  readonly selection: NativeScheduleModel;
  readonly supportsExternal: boolean;
  readonly hasTarget: boolean;
  readonly isSaving: boolean;
  readonly title: string;
  readonly targetThreadId: string | null;
  /** Attach only a confirmed native chat created for this external task draft. */
  setTargetThread(threadId: string, expectedModel: string): void;
  /** Only changes this new task's Model; never the Composer or Account defaults. */
  setModel(selection: NativeScheduleModel): void;
}

function ancestors(element: unknown) {
  if (!record(element)) return [];
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
  return committedReactAncestors(key ? Object.getOwnPropertyDescriptor(element, key)?.value : null);
}

/** Desktop 26.1023 configuration dialog. Bind through semantic props, not hook
 * indices, translated labels or bundle names. Existing task edits do not bind.
 */
export function readNativeScheduleForm(form: unknown): NativeScheduleForm | null {
  const candidates = ancestors(form).flatMap(({ memoizedProps: props }) => {
    if (
      !record(props) ||
      !record(props.setup) ||
      props.setup.triggerMode !== "create" ||
      !record(props.draft) ||
      !record(props.draft.scheduleConfig) ||
      typeof props.draft.scheduleDirty !== "boolean" ||
      typeof props.draft.prompt !== "string" ||
      props.draft.id != null ||
      !["heartbeat", "cron"].includes(String(props.draft.kind)) ||
      !["local", "cloud"].includes(String(props.executionLocation)) ||
      typeof props.onChange !== "function" ||
      typeof props.onSubmit !== "function" ||
      typeof props.isSaving !== "boolean" ||
      (props.draft.model !== null && typeof props.draft.model !== "string") ||
      (props.draft.reasoningEffort !== null && typeof props.draft.reasoningEffort !== "string")
    )
      return [];
    return [props];
  });
  // Pass-through wrappers may carry the exact same owned draft and callbacks.
  const props = candidates[0];
  if (
    !props ||
    candidates.some(
      (other) =>
        other.draft !== props.draft ||
        other.onChange !== props.onChange ||
        other.onSubmit !== props.onSubmit,
    )
  )
    return null;
  const draft = props.draft as RecordValue;
  const change = props.onChange as (update: (current: RecordValue) => RecordValue) => void;
  const supportsExternal =
    props.executionLocation === "local" &&
    draft.kind === "heartbeat" &&
    draft.cloudTeam == null &&
    (!record(props.creation) || props.creation.type === "task") &&
    (!record(draft.eventTrigger) || draft.eventTrigger.selected !== true) &&
    (!Array.isArray(draft.webhookTriggers) || draft.webhookTriggers.length === 0);
  return {
    selection: {
      model: draft.model as string | null,
      reasoningEffort: draft.reasoningEffort as string | null,
    },
    supportsExternal,
    hasTarget: draft.targetThreadId != null,
    isSaving: props.isSaving as boolean,
    title:
      (typeof draft.name === "string" ? draft.name.trim() : "") ||
      String(draft.prompt).trim().replace(/\s+/gu, " ").slice(0, 80),
    targetThreadId: typeof draft.targetThreadId === "string" ? draft.targetThreadId : null,
    setTargetThread(threadId, expectedModel) {
      if (
        !supportsExternal ||
        props.isSaving ||
        draft.targetThreadId != null ||
        !threadId ||
        !expectedModel.startsWith("codexhost/plugin-v1@")
      )
        return;
      change((current) =>
        current.id == null &&
        current.targetThreadId == null &&
        current.kind === "heartbeat" &&
        current.cloudTeam == null &&
        current.model === expectedModel
          ? { ...current, targetThreadId: threadId }
          : current,
      );
    },
    setModel(selection) {
      if (props.isSaving || draft.targetThreadId != null) return;
      change((current) =>
        current.id == null && current.targetThreadId == null && current.kind === draft.kind
          ? { ...current, ...selection }
          : current,
      );
    },
  };
}

interface ScheduleRow {
  hidden: boolean;
  style: {
    getPropertyValue(property: string): string;
    getPropertyPriority(property: string): string;
    setProperty(property: string, value: string, priority?: string): void;
  };
}
interface ScheduleFormElement {
  querySelectorAll(selector: string): Iterable<unknown>;
  contains(element: unknown): boolean;
}
/** Identify the native Codex Model/Effort rows by their semantic labels. */
export function nativeScheduleModelRows(form: ScheduleFormElement): ScheduleRow[] {
  const rows = new Set<ScheduleRow>();
  for (const button of form.querySelectorAll("button")) {
    let host: ScheduleRow | null = null;
    for (const fiber of ancestors(button)) {
      const node = fiber.stateNode;
      if (node === form) break;
      if (
        record(node) &&
        node.nodeType === 1 &&
        typeof node.hidden === "boolean" &&
        record(node.style) &&
        ["getPropertyValue", "getPropertyPriority", "setProperty"].every(
          (method) => typeof (node.style as RecordValue)[method] === "function",
        ) &&
        form.contains(node)
      )
        host = node as unknown as ScheduleRow;
      const props = fiber.memoizedProps;
      const label = record(props) && record(props.label) ? props.label.props : null;
      if (
        record(label) &&
        ["inbox.automations.model.label", "automations.configuration.effort"].includes(
          String(label.id),
        )
      ) {
        if (host) rows.add(host);
        break;
      }
    }
  }
  return [...rows];
}

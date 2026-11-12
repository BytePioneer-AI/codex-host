import type { SkillsListParams, SkillsListResult } from "@codexhost/shared-contracts";
import type { RendererDelegationSkillSource } from "./renderer-delegation-mention.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

export interface RendererSkillContext {
  client: RendererModelClient;
  params: SkillsListParams;
}

interface ActiveLibrary {
  editor: HTMLElement;
  context: RendererSkillContext;
  key: string;
  result?: SkillsListResult;
  error?: string;
  pending: boolean;
  dirty: boolean;
  unsubscribe?: () => void;
}

/** A menu-local snapshot: typing filters it; only opening and Host notifications query it. */
export function createRendererSkillLibrary(options: {
  context(editor: HTMLElement): RendererSkillContext | null;
  locale(): RendererSettingsLocale;
  changed(): void;
}) {
  let active: ActiveLibrary | null = null;
  const key = (context: RendererSkillContext): string => JSON.stringify(context.params);
  const current = (state: ActiveLibrary): boolean => {
    const context = options.context(state.editor);
    return (
      active === state && context?.client === state.context.client && key(context) === state.key
    );
  };
  const close = (): void => {
    active?.unsubscribe?.();
    active = null;
  };
  const query = async (state: ActiveLibrary): Promise<void> => {
    if (state.pending) {
      state.dirty = true;
      return;
    }
    do {
      state.dirty = false;
      state.pending = true;
      delete state.error;
      try {
        if (!state.context.client.listSkills)
          throw new Error("This Host does not support the Skill Library");
        const result = await state.context.client.listSkills(state.context.params);
        if (!current(state)) return;
        state.result = result;
      } catch (error) {
        if (!current(state)) return;
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        state.pending = false;
      }
      options.changed();
    } while (state.dirty && current(state));
  };
  const open = (editor: HTMLElement): void => {
    const context = options.context(editor);
    if (!context) {
      close();
      return;
    }
    if (active?.context.client === context.client && active.key === key(context)) {
      active.editor = editor;
      return;
    }
    close();
    const state: ActiveLibrary = {
      editor,
      context,
      key: key(context),
      pending: false,
      dirty: false,
    };
    active = state;
    if (context.client.subscribeSkillsChanged) {
      state.unsubscribe = context.client.subscribeSkillsChanged((change) => {
        if (!current(state)) return;
        if (change.cwd && !context.params.threadId && change.cwd !== context.params.cwd) return;
        void query(state);
      });
    }
    void query(state);
  };
  return {
    open,
    close,
    read(editor: HTMLElement): RendererDelegationSkillSource | null {
      const context = options.context(editor);
      if (!context) return null;
      if (!active || active.context.client !== context.client || active.key !== key(context))
        open(editor);
      const state = active;
      if (!state) return null;
      const zh = options.locale() === "zh-CN";
      return {
        skills: state.result?.skills ?? [],
        ...(!state.result && state.pending
          ? { notice: zh ? "正在加载 Skill…" : "Loading Skills…" }
          : state.result?.complete === false
            ? { notice: zh ? "正在发现 Skill…" : "Discovering Skills…" }
            : {}),
        ...(state.result?.warnings?.length ? { warning: state.result.warnings.join("\n") } : {}),
        ...(state.error ? { error: state.error } : {}),
        retry: () => {
          if (current(state)) {
            void query(state);
            options.changed();
          }
        },
      };
    },
    dispose: close,
  };
}

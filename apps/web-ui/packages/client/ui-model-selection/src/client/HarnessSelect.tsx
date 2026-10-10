/** Native Harness identity picker beside the independent model/effort control. */
import { useRef, useState, useSyncExternalStore } from "react";
import {
  IconDataOutlineRegular,
  RemotePluginIcon,
  IconWarningOutlineRegular,
  Menu,
  type MenuEntry,
  StateDot,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ModelSelectInjected } from "./slots.ts";
import css from "./HarnessSelect.module.css";

/** Show the plugin's own brand asset, with a generic glyph when it has no icon. */
function HarnessIcon({ id }: { id: string }) {
  return (
    <RemotePluginIcon
      id={id}
      src={`/harness-icons/${encodeURIComponent(id)}`}
      presentationUrl="/harness-icons/presentation.json"
      size={20}
      className={css.icon}
      fallback={<IconDataOutlineRegular size={20} />}
    />
  );
}

/** Select through the same per-session directory and confirmed projection as the model menu. */
export function HarnessSelect({
  available,
  directory,
  load,
  select,
  locked,
  t,
}: ModelSelectInjected & { locked: boolean } & PropsLocale<"model">) {
  const state = useSyncExternalStore(
    (fn) => directory.subscribe(fn),
    () => directory.getSnapshot(),
  );
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const currentId = state.current?.provider;
  const currentName =
    state.harnesses.find((group) => group.id === currentId)?.name ??
    state.failures.find((failure) => failure.id === currentId)?.name ??
    currentId;
  const busy = state.pending !== null;
  const footer: MenuEntry[] = [];
  if (state.boundHarnessId !== null)
    footer.push({ type: "label", id: "bound", text: t("harness.bound") });
  if (state.status === "loading")
    footer.push({ type: "label", id: "loading", text: t("trigger.loading") });
  if (state.error !== null) footer.push({ type: "label", id: "error", text: state.error });
  if (state.harnesses.length === 0 && state.status !== "loading")
    footer.push({ type: "label", id: "empty", text: t("harness.empty") });
  const close = () => setOpen(false);
  const report = (text: string) =>
    setToast((previous) => ({ text, seq: (previous?.seq ?? 0) + 1 }));

  if (!available) return null;

  const choose = async (id: string): Promise<void> => {
    if (locked || busy || (state.boundHarnessId !== null && id !== state.boundHarnessId)) return;
    if (id === currentId) {
      close();
      return;
    }
    const model = state.harnesses.find((group) => group.id === id)?.models[0];
    if (model === undefined) return;
    close();
    try {
      const result = await select({
        provider: id,
        model: model.id,
        ...(model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort }),
      });
      if (result !== undefined && !result.ok)
        report(t("error.action", { message: result.error.message }));
    } catch (error) {
      report(
        t("error.action", { message: error instanceof Error ? error.message : String(error) }),
      );
    }
  };

  return (
    <>
      <Menu
        open={open}
        portal
        side="top"
        align="end"
        autoFocus
        listClassName={css.menu}
        selectedId={currentId}
        items={[
          ...state.harnesses.map((group) => ({
            id: group.id,
            label: <span data-current={group.id === currentId ? "" : undefined}>{group.name}</span>,
            icon: <HarnessIcon key={group.id} id={group.id} />,
            disabled:
              locked ||
              busy ||
              group.models.length === 0 ||
              (state.boundHarnessId !== null && group.id !== state.boundHarnessId),
          })),
          ...state.failures.map((failure) => ({
            id: failure.id,
            label: (
              <span title={failure.message}>
                {failure.name} · {t("harness.unavailable")}
              </span>
            ),
            icon: <HarnessIcon key={failure.id} id={failure.id} />,
            disabled: true,
          })),
        ]}
        onSelect={(id) => {
          void choose(id);
        }}
        onClose={close}
        footer={footer}
        anchor={
          <button
            ref={trigger}
            type="button"
            className={css.trigger}
            title={currentName ?? t("harness.select")}
            aria-label={
              currentName === undefined
                ? t("harness.select")
                : t("harness.aria", { name: currentName })
            }
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={busy}
            disabled={locked || busy}
            onClick={() => {
              setOpen(!open);
              if (!open) load();
            }}
          >
            {busy ? (
              <StateDot state="ongoing" />
            ) : currentId === undefined ? (
              <IconDataOutlineRegular size={20} />
            ) : (
              <HarnessIcon key={currentId} id={currentId} />
            )}
          </button>
        }
      />
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={trigger.current?.closest<HTMLElement>("[data-composer-card]") ?? null}
          onDone={() => setToast(null)}
        />
      )}
    </>
  );
}

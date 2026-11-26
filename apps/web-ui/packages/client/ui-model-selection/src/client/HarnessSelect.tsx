/** Native Harness identity picker beside the independent model/effort control. */
import { useRef, useState, useSyncExternalStore } from "react";
import {
  harnessIconSources,
  IconDataOutlineRegular,
  RemotePluginIcon,
  IconWarningOutlineRegular,
  Menu,
  type MenuEntry,
  StateDot,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { HarnessHandoffStatus, ModelSelectInjected } from "./slots.ts";
import css from "./HarnessSelect.module.css";

const HANDOFF_ITEM_PREFIX = "handoff:";
const noopSubscribe = () => () => {};
const noopHostId = () => undefined;
const noopHandoffStatus = (): HarnessHandoffStatus => "unsupported";

function HandoffSwapIcon({ className }: { className?: string }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 5.25H13.25" />
      <path d="M10.5 2.75L13.25 5.25L10.5 7.75" />
      <path d="M13.5 10.75H2.75" />
      <path d="M5.5 8.25L2.75 10.75L5.5 13.25" />
    </svg>
  );
}

/** Show the plugin's own brand asset, with a generic glyph when it has no icon or remote host is unresolved. */
function HarnessIcon({
  id,
  hostId,
  deferRemote = false,
  size = 20,
}: {
  id: string;
  hostId?: string | undefined;
  deferRemote?: boolean;
  size?: number;
}) {
  if (deferRemote && id !== "codex") {
    return <IconDataOutlineRegular size={size} />;
  }
  const icon = harnessIconSources(id, hostId);
  return (
    <RemotePluginIcon
      id={id}
      src={icon.src}
      presentationUrl={icon.presentationUrl}
      size={size}
      className={css.icon}
      fallback={<IconDataOutlineRegular size={size} />}
    />
  );
}

/** Select through the same per-session directory and confirmed projection as the model menu. */
export function HarnessSelect({
  available,
  directory,
  load,
  select,
  iconHost,
  handoff,
  locked,
  t,
}: ModelSelectInjected & { locked: boolean } & PropsLocale<"model">) {
  const state = useSyncExternalStore(
    (fn) => directory.subscribe(fn),
    () => directory.getSnapshot(),
  );
  const iconHostId = useSyncExternalStore(
    iconHost?.subscribe ?? noopSubscribe,
    iconHost?.getHostId ?? noopHostId,
  );
  const handoffStatus = useSyncExternalStore(
    handoff?.subscribe ?? noopSubscribe,
    handoff?.getStatus ?? noopHandoffStatus,
  );
  const deferRemoteIcon = iconHost?.isRemoteSession === true && iconHostId === undefined;
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const currentId = state.current?.provider;
  const currentName =
    state.harnesses.find((group) => group.id === currentId)?.name ??
    state.failures.find((failure) => failure.id === currentId)?.name ??
    currentId;
  const busy = state.pending !== null;
  const boundHarnessId = state.boundHarnessId;
  const boundHandoffEnabled = boundHarnessId !== null && handoffStatus !== "unsupported";

  const ranks = state.harnessOrder ?? [];
  const compareOrder = (leftId: string, rightId: string): number => {
    const left = ranks.indexOf(leftId);
    const right = ranks.indexOf(rightId);
    return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right);
  };
  const renderIcon = (id: string) => (
    <HarnessIcon key={id} id={id} hostId={iconHostId} deferRemote={deferRemoteIcon} />
  );
  const failureEntry = (failure: (typeof state.failures)[number]): MenuEntry => ({
    id: failure.id,
    label: (
      <span title={failure.message}>
        {failure.name} · {t("harness.unavailable")}
      </span>
    ),
    icon: renderIcon(failure.id),
    disabled: true,
  });

  const items: MenuEntry[] = [];
  if (boundHandoffEnabled) {
    const sortedHarnesses = state.harnesses.toSorted((a, b) => compareOrder(a.id, b.id));
    const sortedFailures = state.failures.toSorted((a, b) => compareOrder(a.id, b.id));
    const boundGroup = sortedHarnesses.find((group) => group.id === boundHarnessId);
    const boundFailure = sortedFailures.find((failure) => failure.id === boundHarnessId);
    if (boundGroup !== undefined) {
      items.push({
        id: boundGroup.id,
        label: (
          <span data-current={boundGroup.id === currentId ? "" : undefined}>{boundGroup.name}</span>
        ),
        icon: renderIcon(boundGroup.id),
        disabled: locked || busy,
      });
    } else if (boundFailure !== undefined) {
      items.push(failureEntry(boundFailure));
    }

    const otherHarnesses = sortedHarnesses.filter((group) => group.id !== boundHarnessId);
    const otherFailures = sortedFailures.filter((failure) => failure.id !== boundHarnessId);
    const handoffRows: MenuEntry[] =
      otherHarnesses.length > 0
        ? otherHarnesses.map((group) => ({
            id: `${HANDOFF_ITEM_PREFIX}${group.id}`,
            label: (
              <span className={css.handoffLabel}>
                <span className={css.harnessName}>{group.name}</span>
                <HandoffSwapIcon className={css.handoffIcon} />
              </span>
            ),
            icon: renderIcon(group.id),
            disabled: locked || busy || group.models.length === 0 || handoffStatus !== "ready",
          }))
        : boundGroup !== undefined
          ? [
              {
                id: `${HANDOFF_ITEM_PREFIX}${boundGroup.id}`,
                label: (
                  <span className={css.handoffLabel}>
                    <span className={css.harnessName}>
                      {t("harness.handoffSame", { name: boundGroup.name })}
                    </span>
                    <HandoffSwapIcon className={css.handoffIcon} />
                  </span>
                ),
                icon: renderIcon(boundGroup.id),
                disabled:
                  locked || busy || boundGroup.models.length === 0 || handoffStatus !== "ready",
              },
            ]
          : [];

    if (handoffRows.length > 0 || otherFailures.length > 0) {
      if (items.length > 0) {
        items.push({ type: "separator", id: "handoff-separator" });
      }
      if (handoffRows.length > 0) {
        items.push({
          type: "label",
          id: "handoff-section",
          text: t("harness.handoffSection"),
        });
      }
      items.push(...handoffRows, ...otherFailures.map(failureEntry));
    }
  } else {
    items.push(
      ...[
        ...state.harnesses.map((group) => ({
          id: group.id,
          label: <span data-current={group.id === currentId ? "" : undefined}>{group.name}</span>,
          icon: renderIcon(group.id),
          disabled:
            locked ||
            busy ||
            group.models.length === 0 ||
            (boundHarnessId !== null && group.id !== boundHarnessId),
        })),
        ...state.failures.map(failureEntry),
      ].toSorted((a, b) => compareOrder(a.id, b.id)),
    );
  }

  const footer: MenuEntry[] = [];
  if (boundHarnessId !== null) {
    if (boundHandoffEnabled) {
      footer.push({
        type: "label",
        id: handoffStatus === "pending" ? "bound-pending" : "bound-handoff",
        text: handoffStatus === "pending" ? t("harness.handoffWaitTurn") : t("harness.handoffHint"),
      });
    } else if (iconHost?.isRemoteSession === true) {
      footer.push({ type: "label", id: "bound-remote", text: t("harness.boundRemote") });
    } else {
      footer.push({ type: "label", id: "bound", text: t("harness.bound") });
    }
  }
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
    if (id.startsWith(HANDOFF_ITEM_PREFIX)) {
      if (locked || busy || handoffStatus !== "ready" || handoff === undefined) return;
      const targetHarnessId = id.slice(HANDOFF_ITEM_PREFIX.length);
      close();
      handoff.open(targetHarnessId);
      return;
    }
    if (locked || busy || (boundHarnessId !== null && id !== boundHarnessId)) return;
    if (id === currentId) {
      close();
      return;
    }
    const group = state.harnesses.find((candidate) => candidate.id === id);
    const remembered = state.rememberedSelections?.[id];
    const model =
      group?.models.find((candidate) => candidate.id === remembered?.model) ?? group?.models[0];
    if (model === undefined) return;
    const rememberedEffort = model.reasoning?.efforts.some(
      (option) => option.id === remembered?.reasoningEffort,
    )
      ? remembered?.reasoningEffort
      : undefined;
    const reasoningEffort = rememberedEffort ?? model.reasoning?.defaultEffort;
    close();
    try {
      const result = await select({
        provider: id,
        model: model.id,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
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
        items={items}
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
              <IconDataOutlineRegular size={16} />
            ) : (
              <HarnessIcon
                key={currentId}
                id={currentId}
                hostId={iconHostId}
                deferRemote={deferRemoteIcon}
                size={16}
              />
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

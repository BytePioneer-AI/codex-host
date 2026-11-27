/** Native Harness identity picker beside the independent model/effort control. */
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  harnessIconSources,
  IconCheckOutlineRegular,
  IconDataOutlineRegular,
  RemotePluginIcon,
  IconWarningOutlineRegular,
  Menu,
  type MenuEntry,
  StateDot,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { buildHarnessMenuLayout, type HarnessMenuEntry } from "./harness-menu.ts";
import type { HarnessHandoffStatus, ModelSelectInjected } from "./slots.ts";
import css from "./HarnessSelect.module.css";

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
  openConnections,
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const currentId = state.current?.provider;
  const currentName =
    state.harnesses.find((group) => group.id === currentId)?.name ??
    state.failures.find((failure) => failure.id === currentId)?.name ??
    state.notInstalled.find((missing) => missing.id === currentId)?.name ??
    currentId;
  const busy = state.pending !== null;
  const boundHarnessId = state.boundHarnessId;
  const boundHandoffEnabled = boundHarnessId !== null && handoffStatus !== "unsupported";

  const layout = useMemo(
    () =>
      buildHarnessMenuLayout({
        harnesses: state.harnesses,
        failures: state.failures,
        notInstalled: iconHost?.isRemoteSession === true ? [] : state.notInstalled,
        harnessOrder: state.harnessOrder,
        moreHarnesses: iconHost?.isRemoteSession === true ? [] : state.moreHarnesses,
        boundHarnessId,
        boundHandoffEnabled,
      }),
    [
      boundHandoffEnabled,
      boundHarnessId,
      iconHost?.isRemoteSession,
      state.failures,
      state.harnessOrder,
      state.harnesses,
      state.moreHarnesses,
      state.notInstalled,
    ],
  );

  const footer: MenuEntry[] = [];
  if (boundHarnessId !== null) {
    if (boundHandoffEnabled) {
      footer.push({
        type: "label",
        id:
          handoffStatus === "ready"
            ? "bound-handoff"
            : handoffStatus === "pending"
              ? "bound-pending"
              : "bound-unavailable",
        text:
          handoffStatus === "ready"
            ? t("harness.handoffHint")
            : handoffStatus === "pending"
              ? t("harness.handoffWaitTurn")
              : t("harness.handoffNoContext"),
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

  const close = () => {
    setOpen(false);
    setMoreOpen(false);
  };
  const report = (text: string) =>
    setToast((previous) => ({ text, seq: (previous?.seq ?? 0) + 1 }));

  if (!available) return null;

  const chooseDraft = async (id: string): Promise<void> => {
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

  const triggerHandoff = (targetHarnessId: string): void => {
    if (locked || busy || handoffStatus !== "ready" || handoff === undefined) return;
    close();
    handoff.open(targetHarnessId);
  };

  const handleInstall = (entry: Extract<HarnessMenuEntry, { kind: "notInstalled" }>): void => {
    close();
    if (entry.installUrl !== undefined) {
      window.open(entry.installUrl, "_blank", "noopener,noreferrer");
      return;
    }
    openConnections?.(entry.id);
  };

  const handleErrorDetails = (agentId: string): void => {
    close();
    openConnections?.(agentId);
  };

  const renderEntryRow = (
    entry: HarnessMenuEntry,
    mode: "current" | "draft" | "handoff",
    labelOverride?: string,
  ) => {
    const isCurrent = mode === "current" || (mode === "draft" && entry.id === currentId);
    const rowDisabled =
      locked ||
      busy ||
      (entry.kind !== "ready" && !isCurrent) ||
      (entry.kind === "ready" && !entry.hasModels && !isCurrent) ||
      (mode === "draft" && boundHarnessId !== null && entry.id !== boundHarnessId) ||
      (mode === "handoff" && handoffStatus !== "ready");
    const showSwap = mode === "handoff" && entry.kind === "ready" && entry.hasModels;
    const showInstall =
      entry.kind === "notInstalled" &&
      (entry.installUrl !== undefined || openConnections !== undefined);
    const showError = entry.kind === "error" && openConnections !== undefined;
    const title = entry.kind === "error" ? entry.message : undefined;
    const displayLabel = labelOverride ?? entry.name;

    return (
      <div key={`${mode}:${entry.id}`} className={css.row}>
        <button
          type="button"
          role="menuitem"
          className={css.rowButton}
          data-current={isCurrent ? "" : undefined}
          disabled={rowDisabled}
          title={title}
          onClick={() => {
            if (mode === "handoff") {
              triggerHandoff(entry.id);
              return;
            }
            if (isCurrent) {
              close();
              return;
            }
            void chooseDraft(entry.id);
          }}
        >
          <span className={css.rowIcon}>
            <HarnessIcon
              id={entry.id}
              hostId={iconHostId}
              deferRemote={deferRemoteIcon}
              size={20}
            />
          </span>
          <span className={css.harnessName}>{displayLabel}</span>
        </button>
        <span className={css.actionSlot}>
          {isCurrent ? (
            <IconCheckOutlineRegular className={css.checkIcon} />
          ) : showSwap ? (
            <HandoffSwapIcon className={css.handoffIcon} />
          ) : showInstall ? (
            <button
              type="button"
              className={`${css.rowActionButton} ${css.installButton}`}
              aria-label={t("harness.installAria", { name: entry.name })}
              title={t("harness.installAria", { name: entry.name })}
              onClick={(event) => {
                event.stopPropagation();
                handleInstall(entry);
              }}
            >
              +
            </button>
          ) : showError ? (
            <button
              type="button"
              className={`${css.rowActionButton} ${css.errorButton}`}
              aria-label={t("harness.errorAria", { name: entry.name })}
              title={t("harness.errorAria", { name: entry.name })}
              onClick={(event) => {
                event.stopPropagation();
                handleErrorDetails(entry.id);
              }}
            >
              !
            </button>
          ) : null}
        </span>
      </div>
    );
  };

  const rowMode: "draft" | "handoff" = boundHandoffEnabled ? "handoff" : "draft";
  const hasSecondaryContent =
    layout.showSameHarnessHandoff || layout.main.length > 0 || layout.more.length > 0;
  const hasHandoffTarget =
    layout.showSameHarnessHandoff ||
    layout.main.some((entry) => entry.kind === "ready" && entry.hasModels) ||
    layout.more.some((entry) => entry.kind === "ready" && entry.hasModels);

  return (
    <>
      <Menu
        open={open}
        portal
        side="top"
        align="end"
        autoFocus
        listClassName={css.menu}
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
              if (open) close();
              else {
                setOpen(true);
                load();
              }
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
      >
        {boundHandoffEnabled && layout.boundEntry !== undefined && (
          <div className={css.group}>{renderEntryRow(layout.boundEntry, "current")}</div>
        )}
        {boundHandoffEnabled && hasSecondaryContent && (
          <>
            {layout.boundEntry !== undefined && <div className={css.separator} role="separator" />}
            {hasHandoffTarget && (
              <div className={css.sectionLabel} role="presentation">
                {t("harness.handoffSection")}
              </div>
            )}
          </>
        )}
        {(layout.showSameHarnessHandoff || layout.main.length > 0) && (
          <div className={css.group}>
            {layout.showSameHarnessHandoff &&
              layout.boundEntry !== undefined &&
              renderEntryRow(
                layout.boundEntry,
                "handoff",
                t("harness.handoffSame", { name: layout.boundEntry.name }),
              )}
            {layout.main.map((entry) => renderEntryRow(entry, rowMode))}
          </div>
        )}
        {layout.more.length > 0 && (
          <>
            <button
              type="button"
              className={css.moreToggle}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((prev) => !prev)}
            >
              <span className={css.moreArrow} aria-hidden="true">
                {moreOpen ? "▾" : "▸"}
              </span>
              <span>{t("harness.moreAgents", { count: layout.more.length })}</span>
            </button>
            {moreOpen && (
              <div className={css.morePanel}>
                <div className={css.group}>
                  {layout.more.map((entry) => renderEntryRow(entry, rowMode))}
                </div>
                {openConnections !== undefined && (
                  <button
                    type="button"
                    className={css.manageLink}
                    onClick={() => {
                      close();
                      openConnections();
                    }}
                  >
                    {t("harness.manage")} →
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {layout.showHideUnusedCta && openConnections !== undefined && (
          <button
            type="button"
            className={css.hideUnusedCta}
            onClick={() => {
              close();
              openConnections();
            }}
          >
            ⚙ {t("harness.hideUnusedCta")} →
          </button>
        )}
      </Menu>
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

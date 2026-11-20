import type {
  DesktopExtensionMutationResult,
  DesktopExtensionSelectionParams,
  DesktopExtensionSlot,
  DesktopExtensionStatus,
  DesktopExtensionsListResult,
  DesktopExtensionsRecoveryParams,
} from "@codexhost/shared-contracts";
import { RendererMethodUnavailableError } from "../renderer-request-sender.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { DesktopExtensionsMessages } from "./desktop-extensions-messages.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceSwitch, preferenceId } from "./preference-ui.js";

const POLL_INTERVAL_MS = 5_000;
const COPY_FEEDBACK_MS = 2_000;
const EXTENSIONS_ROOT_DISPLAY = "$CODEXHOST_DATA_DIR/extensions/";

export interface RendererDesktopExtensionsClient {
  listDesktopExtensions?(): Promise<DesktopExtensionsListResult>;
  enableDesktopExtension?(
    input: DesktopExtensionSelectionParams,
  ): Promise<DesktopExtensionMutationResult>;
  disableDesktopExtension?(
    input: DesktopExtensionSelectionParams,
  ): Promise<DesktopExtensionMutationResult>;
  disableAllDesktopExtensionsAndReload?(
    input?: DesktopExtensionsRecoveryParams,
  ): Promise<DesktopExtensionMutationResult>;
}

type DesktopExtensionItem = DesktopExtensionsListResult["extensions"][number];
type BannerTone = "info" | "success" | "warning" | "danger";

interface FeedbackBanner {
  readonly tone: BannerTone;
  readonly text: string;
  readonly retryable?: boolean;
}

function formatMessage(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, key: string) => values[key] ?? match);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function extensionDisplayName(item: DesktopExtensionItem): string {
  return item.manifest?.name ?? item.id;
}

function extensionDescription(
  item: DesktopExtensionItem,
  locale: RendererSettingsMessages["locale"],
): string | null {
  const description = item.manifest?.description;
  if (!description) return null;
  const preferred = locale === "zh-CN" ? (description["zh-CN"] ?? description.en) : description.en;
  const trimmed = preferred.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function statusTone(state: DesktopExtensionStatus["state"]): BannerTone | "neutral" {
  if (state === "running") return "success";
  if (state === "waiting") return "info";
  if (state === "conflict" || state === "incompatible") return "warning";
  if (state === "failed" || state === "invalid") return "danger";
  return "neutral";
}

function formatSlotLabel(slot: DesktopExtensionSlot, copy: DesktopExtensionsMessages): string {
  const localized = copy.slots[slot];
  return localized ? `${localized} (${slot})` : slot;
}

function describeOtherExtension(
  conflictWithId: string,
  extensions: readonly DesktopExtensionItem[],
): string {
  const other = extensions.find((item) => item.id === conflictWithId);
  const name = other?.manifest?.name;
  return name && name !== conflictWithId ? `${name} (${conflictWithId})` : conflictWithId;
}

function overlappingSlots(
  target: DesktopExtensionItem,
  conflictWithId: string,
  extensions: readonly DesktopExtensionItem[],
): readonly DesktopExtensionSlot[] {
  const targetSlots = target.manifest?.slots ?? [];
  if (targetSlots.length === 0) return [];
  const otherSlots = extensions.find((item) => item.id === conflictWithId)?.manifest?.slots;
  if (!otherSlots || otherSlots.length === 0) return targetSlots;
  const shared = targetSlots.filter((slot) => otherSlots.includes(slot));
  return shared.length > 0 ? shared : targetSlots;
}

function isToggleBlocked(item: DesktopExtensionItem): boolean {
  if (item.enabled) return false;
  return (
    item.status.state === "incompatible" ||
    item.status.state === "invalid" ||
    item.manifest === undefined
  );
}

function blockedToggleReason(item: DesktopExtensionItem, copy: DesktopExtensionsMessages): string {
  if (item.status.error) return item.status.error;
  return item.status.state === "incompatible"
    ? copy.toggleDisabledIncompatible
    : copy.toggleDisabledInvalid;
}

function resolveAvailableClient(
  getClient: () => RendererDesktopExtensionsClient | null,
): RendererDesktopExtensionsClient | null {
  const client = getClient();
  return client && typeof client.listDesktopExtensions === "function" ? client : null;
}

export function createDesktopExtensionsSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererDesktopExtensionsClient | null = () => null,
): RendererSettingsPageDefinition {
  const copy = messages.desktopExtensions;
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "desktop-extensions",
    label: messages.pageLabels["desktop-extensions"],
    icon: "extensions",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const ownerWindow = document.defaultView;
      const root = createEl(document, "div", "settings-extensions");

      const header = createEl(document, "div", "settings-remote__header");
      const headerCopy = createEl(document, "div");
      const title = createEl(
        document,
        "h1",
        "settings-section-label",
        messages.pageLabels["desktop-extensions"],
      );
      const description = createEl(document, "p", "settings-page-description", copy.description);
      headerCopy.append(title, description);

      const toolbar = createEl(document, "div", "settings-remote__toolbar");
      const refreshButton = createEl(
        document,
        "button",
        "settings-icon-button settings-remote__refresh",
      );
      refreshButton.type = "button";
      refreshButton.title = copy.refresh;
      refreshButton.setAttribute("aria-label", copy.refresh);
      refreshButton.append(createRendererSettingsIcon("refresh", 16));
      toolbar.append(refreshButton);
      header.append(headerCopy, toolbar);

      // Directory hint and live Desktop Controller connection summary.
      const metaBar = createEl(document, "div", "settings-extensions__meta");
      const directoryGroup = createEl(document, "div", "settings-extensions__directory");
      const directoryLabel = createEl(
        document,
        "span",
        "settings-extensions__directory-label",
        copy.directoryLabel,
      );
      const directoryCode = createEl(document, "code", "", EXTENSIONS_ROOT_DISPLAY);
      const directoryHint = createEl(
        document,
        "span",
        "settings-extensions__directory-hint",
        copy.directoryDefaultHint,
      );
      const copyPathButton = createEl(document, "button", "settings-extensions__copy-button");
      copyPathButton.type = "button";
      let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
      const setCopyButtonLabel = (label: string): void => {
        copyPathButton.replaceChildren(createRendererSettingsIcon("copy", 13), label);
      };
      setCopyButtonLabel(copy.copyPath);
      copyPathButton.addEventListener("click", () => {
        const clipboard = ownerWindow?.navigator?.clipboard;
        const flash = (label: string): void => {
          setCopyButtonLabel(label);
          clearTimeout(copyResetTimer);
          copyResetTimer = setTimeout(() => {
            if (!disposed && !context.signal.aborted) setCopyButtonLabel(copy.copyPath);
          }, COPY_FEEDBACK_MS);
        };
        if (!clipboard) {
          flash(copy.copyPathFailed);
          return;
        }
        void clipboard.writeText(EXTENSIONS_ROOT_DISPLAY).then(
          () => flash(copy.copiedPath),
          () => flash(copy.copyPathFailed),
        );
      });
      directoryGroup.append(directoryLabel, directoryCode, copyPathButton, directoryHint);

      const connectionBadge = createEl(document, "span", "settings-extensions__connection");
      connectionBadge.hidden = true;
      metaBar.append(directoryGroup, connectionBadge);

      const banner = createEl(document, "div", "settings-extensions__banner");
      banner.hidden = true;
      const bannerText = createEl(document, "span");
      const bannerRetry = createEl(
        document,
        "button",
        "settings-command-button settings-command-button--secondary",
        copy.retry,
      );
      bannerRetry.type = "button";
      bannerRetry.hidden = true;
      banner.append(bannerText, bannerRetry);

      const diagnosticsPanel = createEl(document, "section", "settings-extensions__diagnostics");
      diagnosticsPanel.setAttribute("role", "status");
      diagnosticsPanel.hidden = true;

      const body = createEl(document, "div", "settings-extensions__body");

      // Emergency recovery card at the bottom of the page.
      const recoverySection = createEl(document, "section", "settings-extensions-recovery");
      const recoveryCopy = createEl(document, "div", "settings-extensions-recovery__copy");
      const recoveryHeading = createEl(document, "h2", "", copy.recoveryTitle);
      const recoveryDescription = createEl(document, "p", "", copy.recoveryDescription);
      recoveryCopy.append(recoveryHeading, recoveryDescription);
      const recoveryButton = createEl(
        document,
        "button",
        "settings-command-button settings-command-button--secondary settings-command-button--danger",
      );
      recoveryButton.type = "button";
      recoveryButton.append(createRendererSettingsIcon("undo", 15), copy.recoveryButton);
      recoverySection.append(recoveryCopy, recoveryButton);

      root.append(header, metaBar, banner, diagnosticsPanel, body, recoverySection);
      context.content.append(root);

      let disposed = false;
      let listing: DesktopExtensionsListResult | null = null;
      let unavailable = false;
      let loading = false;
      let mutating = false;
      let activeMutationId: string | null = null;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let activeDialog: HTMLDialogElement | null = null;

      const setFeedback = (next: FeedbackBanner | null): void => {
        if (!next) {
          banner.hidden = true;
          bannerText.textContent = "";
          bannerRetry.hidden = true;
          delete banner.dataset.tone;
          return;
        }
        banner.hidden = false;
        banner.dataset.tone = next.tone;
        banner.setAttribute(
          "role",
          next.tone === "danger" || next.tone === "warning" ? "alert" : "status",
        );
        bannerText.textContent = next.text;
        bannerRetry.hidden = !next.retryable;
      };

      const syncToolbarState = (): void => {
        const busy = loading || mutating;
        refreshButton.disabled = busy;
        refreshButton.setAttribute("aria-busy", String(loading));
        refreshButton.title = loading ? copy.refreshing : copy.refresh;
        refreshButton.setAttribute("aria-label", loading ? copy.refreshing : copy.refresh);
        const client = resolveAvailableClient(getClient);
        const canRecover =
          !unavailable &&
          !mutating &&
          Boolean(client && typeof client.disableAllDesktopExtensionsAndReload === "function");
        recoveryButton.disabled = !canRecover;
      };

      const renderConnectionState = (): void => {
        if (!listing || unavailable) {
          connectionBadge.hidden = true;
          return;
        }
        connectionBadge.hidden = false;
        connectionBadge.dataset.tone = listing.desktopConnected ? "success" : "neutral";
        connectionBadge.textContent = listing.desktopConnected
          ? copy.desktopConnected
          : copy.desktopDisconnected;
      };

      const renderDiagnostics = (): void => {
        if (!listing || unavailable || listing.diagnostics.length === 0) {
          diagnosticsPanel.hidden = true;
          diagnosticsPanel.replaceChildren();
          return;
        }
        diagnosticsPanel.hidden = false;
        const heading = createEl(document, "div", "settings-extensions__diagnostics-head");
        heading.append(createRendererSettingsIcon("alert", 14), copy.diagnosticsTitle);
        const items = createEl(document, "ul", "settings-extensions__diagnostics-list");
        for (const entry of listing.diagnostics) {
          items.append(createEl(document, "li", "", entry));
        }
        diagnosticsPanel.replaceChildren(heading, items);
      };

      const renderLoading = (): void => {
        const indicator = createEl(document, "p", "settings-remote__loading");
        indicator.setAttribute("role", "status");
        indicator.append(createEl(document, "span", "settings-remote-spinner"), copy.loading);
        body.replaceChildren(indicator);
      };

      const renderEmptyBox = (headingText: string, detailText: string, pathHint?: string): void => {
        const empty = createEl(
          document,
          "div",
          "settings-remote__empty settings-extensions__empty",
        );
        const copyBox = createEl(document, "div");
        copyBox.append(createEl(document, "strong", "", headingText));
        copyBox.append(createEl(document, "span", "", detailText));
        if (pathHint) {
          const pathLine = createEl(document, "code", "settings-extensions__empty-path", pathHint);
          copyBox.append(pathLine);
        }
        empty.append(copyBox);
        body.replaceChildren(empty);
      };

      const renderExtensionCard = (
        item: DesktopExtensionItem,
        allExtensions: readonly DesktopExtensionItem[],
      ): HTMLElement => {
        const card = createEl(document, "article", "settings-extensions-card");
        card.dataset.extensionId = item.id;
        card.dataset.extensionState = item.status.state;
        if (activeMutationId === item.id) card.dataset.busy = "true";

        const head = createEl(document, "div", "settings-extensions-card__head");
        const identity = createEl(document, "div", "settings-extensions-card__identity");

        const titleRow = createEl(document, "div", "settings-extensions-card__title");
        const displayName = extensionDisplayName(item);
        const nameEl = createEl(document, "h3", "", displayName);
        titleRow.append(nameEl);

        if (item.manifest?.version) {
          titleRow.append(
            createEl(
              document,
              "span",
              "settings-extensions-card__version",
              `v${item.manifest.version}`,
            ),
          );
        }

        const badge = createEl(
          document,
          "span",
          "settings-extensions-badge",
          copy.states[item.status.state],
        );
        badge.dataset.state = item.status.state;
        badge.dataset.tone = statusTone(item.status.state);
        titleRow.append(badge);

        const idRow = createEl(document, "div", "settings-extensions-card__id");
        idRow.append(createEl(document, "code", "", item.id));
        identity.append(titleRow, idRow);

        const desc = extensionDescription(item, messages.locale);
        if (desc) {
          identity.append(createEl(document, "p", "settings-extensions-card__description", desc));
        }

        if (item.manifest) {
          const slotsRow = createEl(document, "div", "settings-extensions-slots");
          if (item.manifest.slots.length === 0) {
            slotsRow.append(
              createEl(
                document,
                "span",
                "settings-status-badge settings-extensions-slot-chip--empty",
                copy.noExclusiveSlots,
              ),
            );
          } else {
            for (const slot of item.manifest.slots) {
              const chip = createEl(
                document,
                "span",
                "settings-status-badge settings-extensions-slot-chip",
                copy.slots[slot] ?? slot,
              );
              chip.dataset.slot = slot;
              chip.title = slot;
              slotsRow.append(chip);
            }
          }
          identity.append(slotsRow);
        }

        const controlColumn = createEl(document, "div", "settings-extensions-card__control");
        const switchId = preferenceId(`desktop-ext-${item.id}`);
        const detailId = preferenceId(`desktop-ext-detail-${item.id}`);
        const blocked = isToggleBlocked(item);
        const toggle = createPreferenceSwitch(document, switchId, detailId);
        toggle.checked = item.enabled;
        toggle.setAttribute("aria-label", formatMessage(copy.toggleLabel, { name: displayName }));
        toggle.disabled = mutating || blocked;
        if (blocked) {
          toggle.title = blockedToggleReason(item, copy);
        }
        toggle.addEventListener("change", () => {
          const desired = toggle.checked;
          if (mutating || blocked) {
            toggle.checked = item.enabled;
            return;
          }
          void toggleExtension(item, desired);
        });
        controlColumn.append(toggle);
        head.append(identity, controlColumn);
        card.append(head);

        // Diagnostic or conflict details for this extension.
        let detailMessage: string | null = null;
        let detailTone: "warning" | "danger" = "danger";
        if (item.status.conflictWith) {
          const other = describeOtherExtension(item.status.conflictWith, allExtensions);
          const shared = overlappingSlots(item, item.status.conflictWith, allExtensions);
          detailMessage =
            shared.length > 0
              ? formatMessage(copy.conflictSlotDetails, {
                  slots: shared.map((slot) => formatSlotLabel(slot, copy)).join(", "),
                  other,
                })
              : formatMessage(copy.conflictOccupiedBy, { other });
          detailTone = "warning";
        } else if (item.status.error) {
          detailMessage = item.status.error;
          detailTone = item.status.state === "incompatible" ? "warning" : "danger";
        } else if (blocked) {
          detailMessage = blockedToggleReason(item, copy);
          detailTone = item.status.state === "incompatible" ? "warning" : "danger";
        }

        if (detailMessage) {
          const detail = createEl(document, "div", "settings-extensions-card__detail");
          detail.id = detailId;
          detail.dataset.tone = detailTone;
          detail.append(
            createRendererSettingsIcon("alert", 14),
            createEl(document, "span", "", detailMessage),
          );
          card.append(detail);
        }

        return card;
      };

      const render = (): void => {
        syncToolbarState();
        renderConnectionState();
        renderDiagnostics();

        if (unavailable) {
          renderEmptyBox(copy.unavailableTitle, copy.unavailableDescription);
          return;
        }
        if (!listing) {
          if (loading) renderLoading();
          else body.replaceChildren();
          return;
        }
        if (listing.extensions.length === 0) {
          renderEmptyBox(copy.emptyTitle, copy.emptyDescription, copy.emptyPathHint);
          return;
        }
        const list = createEl(document, "div", "settings-extensions__list");
        list.setAttribute("aria-label", messages.pageLabels["desktop-extensions"]);
        for (const item of listing.extensions) {
          list.append(renderExtensionCard(item, listing.extensions));
        }
        body.replaceChildren(list);
      };

      const clearPollTimer = (): void => {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      };

      const schedulePoll = (): void => {
        clearPollTimer();
        if (disposed || context.signal.aborted || document.visibilityState === "hidden") return;
        pollTimer = setTimeout(() => {
          if (disposed || context.signal.aborted || mutating || loading || activeDialog) {
            schedulePoll();
            return;
          }
          void load({ silent: true });
        }, POLL_INTERVAL_MS);
      };

      const load = async (
        options: { silent?: boolean; keepFeedback?: boolean } = {},
      ): Promise<void> => {
        const silent = options.silent ?? false;
        const keepFeedback = options.keepFeedback ?? silent;
        const client = resolveAvailableClient(getClient);
        if (!client?.listDesktopExtensions) {
          unavailable = true;
          listing = null;
          loading = false;
          if (!keepFeedback) setFeedback(null);
          render();
          schedulePoll();
          return;
        }

        if (!silent) {
          loading = true;
          if (!keepFeedback) setFeedback(null);
          render();
        }

        const listDesktopExtensions = client.listDesktopExtensions.bind(client);
        await context.runLatest(async () => listDesktopExtensions(), {
          success(result) {
            loading = false;
            unavailable = false;
            listing = result;
            if (!keepFeedback) setFeedback(null);
            render();
            schedulePoll();
          },
          failure(error) {
            loading = false;
            if (error instanceof RendererMethodUnavailableError) {
              unavailable = true;
              listing = null;
              setFeedback(null);
              render();
              return;
            }
            if (!silent || !listing) {
              setFeedback({
                tone: "danger",
                text: formatMessage(copy.loadFailed, { message: errorMessage(error) }),
                retryable: true,
              });
            }
            render();
            schedulePoll();
          },
        });
      };

      const toggleExtension = async (
        item: DesktopExtensionItem,
        enable: boolean,
      ): Promise<void> => {
        if (mutating || disposed || context.signal.aborted) return;
        const client = resolveAvailableClient(getClient);
        const mutate = enable
          ? client?.enableDesktopExtension?.bind(client)
          : client?.disableDesktopExtension?.bind(client);
        if (!mutate) {
          unavailable = true;
          render();
          return;
        }
        const expectedRevision = listing?.configuration.revision ?? 0;
        const displayName = extensionDisplayName(item);
        mutating = true;
        activeMutationId = item.id;
        clearPollTimer();
        render();

        try {
          const result = await mutate({ id: item.id, expectedRevision });
          if (disposed || context.signal.aborted) return;

          if (result.state === "saved") {
            if (listing) {
              listing = {
                ...listing,
                configuration: result.configuration,
                extensions: listing.extensions.map((entry) =>
                  entry.id === item.id ? { ...entry, enabled: enable } : entry,
                ),
              };
            }
            setFeedback({
              tone: "success",
              text: formatMessage(enable ? copy.savedEnabled : copy.savedDisabled, {
                name: displayName,
              }),
            });
            mutating = false;
            activeMutationId = null;
            render();
            await load({ silent: true, keepFeedback: true });
            return;
          }

          if (result.state === "slot-conflict") {
            const allExtensions = listing?.extensions ?? [];
            const other = describeOtherExtension(result.conflictWith, allExtensions);
            const shared = overlappingSlots(item, result.conflictWith, allExtensions);
            setFeedback({
              tone: "warning",
              text:
                shared.length > 0
                  ? formatMessage(copy.slotConflictBannerWithSlots, {
                      name: displayName,
                      slots: shared.map((slot) => formatSlotLabel(slot, copy)).join(", "),
                      other,
                    })
                  : formatMessage(copy.slotConflictBanner, {
                      name: displayName,
                      other,
                    }),
            });
            return;
          }

          if (result.state === "revision-conflict") {
            setFeedback({
              tone: "warning",
              text: copy.revisionConflictBanner,
            });
            mutating = false;
            activeMutationId = null;
            render();
            await load({ silent: true, keepFeedback: true });
            return;
          }
        } catch (error) {
          if (disposed || context.signal.aborted) return;
          if (error instanceof RendererMethodUnavailableError) {
            unavailable = true;
            listing = null;
            setFeedback(null);
            return;
          }
          setFeedback({
            tone: "danger",
            text: formatMessage(copy.actionFailed, { message: errorMessage(error) }),
          });
        } finally {
          if (!disposed && !context.signal.aborted) {
            mutating = false;
            activeMutationId = null;
            render();
            schedulePoll();
          }
        }
      };

      const openRecoveryDialog = (): void => {
        if (disposed || context.signal.aborted || mutating || activeDialog) return;
        const client = resolveAvailableClient(getClient);
        if (!client?.disableAllDesktopExtensionsAndReload) return;

        const modal = createEl(
          document,
          "dialog",
          "settings-account-dialog settings-credential-dialog settings-extensions-dialog",
        );
        const form = createEl(document, "form");
        const heading = createEl(document, "h2", "", copy.recoveryDialogTitle);
        heading.id = preferenceId("extensions-recovery-title");
        modal.setAttribute("aria-labelledby", heading.id);

        const dialogBody = createEl(document, "div", "settings-credential-dialog__body");
        dialogBody.append(createEl(document, "p", "", copy.recoveryDialogDescription));
        if (listing && !listing.desktopConnected) {
          dialogBody.append(
            createEl(
              document,
              "p",
              "settings-extensions-dialog__note",
              copy.recoveryDialogOfflineNote,
            ),
          );
        }

        const dialogError = createEl(document, "p", "settings-credential-dialog__error");
        dialogError.setAttribute("role", "alert");

        const actions = createEl(document, "div", "settings-credential-dialog__actions");
        const cancel = createEl(
          document,
          "button",
          "settings-command-button settings-command-button--secondary",
          copy.recoveryDialogCancel,
        );
        cancel.type = "button";
        const confirm = createEl(
          document,
          "button",
          "settings-command-button settings-command-button--secondary settings-command-button--danger",
          copy.recoveryDialogConfirm,
        );
        confirm.type = "submit";
        actions.append(cancel, confirm);
        form.append(heading, dialogBody, dialogError, actions);
        modal.append(form);

        let dialogBusy = false;
        const setDialogBusy = (next: boolean): void => {
          dialogBusy = next;
          cancel.disabled = next;
          confirm.disabled = next;
          confirm.textContent = next ? copy.recoveryDialogBusy : copy.recoveryDialogConfirm;
          modal.setAttribute("aria-busy", String(next));
        };

        const cleanupDialog = (): void => {
          context.signal.removeEventListener("abort", cleanupDialog);
          if (activeDialog === modal) activeDialog = null;
          modal.remove();
        };

        cancel.addEventListener("click", () => {
          if (!dialogBusy) modal.close();
        });
        modal.addEventListener("cancel", (event) => {
          if (dialogBusy) event.preventDefault();
        });
        modal.addEventListener("close", cleanupDialog);
        context.signal.addEventListener("abort", cleanupDialog, { once: true });

        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (dialogBusy || mutating) return;
          const recover = resolveAvailableClient(getClient)?.disableAllDesktopExtensionsAndReload;
          if (!recover) {
            modal.close();
            unavailable = true;
            render();
            return;
          }

          dialogError.textContent = "";
          setDialogBusy(true);
          mutating = true;
          clearPollTimer();
          syncToolbarState();

          const params: DesktopExtensionsRecoveryParams =
            listing !== null ? { expectedRevision: listing.configuration.revision } : {};

          void recover(params)
            .then(async (result) => {
              if (disposed || context.signal.aborted) return;
              if (result.state === "saved") {
                if (listing) {
                  listing = {
                    ...listing,
                    configuration: result.configuration,
                    extensions: listing.extensions.map((entry) => ({
                      ...entry,
                      enabled: false,
                    })),
                  };
                }
                setFeedback({
                  tone: "info",
                  text: copy.recoverySaved,
                });
                mutating = false;
                modal.close();
                render();
                await load({ silent: true, keepFeedback: true });
                return;
              }

              if (result.state === "revision-conflict") {
                setFeedback({
                  tone: "warning",
                  text: copy.revisionConflictBanner,
                });
                mutating = false;
                modal.close();
                render();
                await load({ silent: true, keepFeedback: true });
                return;
              }

              // Defensive fallback if an unexpected mutation state is returned.
              mutating = false;
              setDialogBusy(false);
              syncToolbarState();
            })
            .catch((error: unknown) => {
              if (disposed || context.signal.aborted) return;
              mutating = false;
              setDialogBusy(false);
              syncToolbarState();
              if (error instanceof RendererMethodUnavailableError) {
                modal.close();
                unavailable = true;
                listing = null;
                setFeedback(null);
                render();
                return;
              }
              dialogError.textContent = formatMessage(copy.actionFailed, {
                message: errorMessage(error),
              });
            });
        });

        activeDialog = modal;
        root.append(modal);
        modal.showModal();
      };

      const onVisibilityChange = (): void => {
        if (document.visibilityState === "hidden") clearPollTimer();
        else if (!disposed && !context.signal.aborted && !mutating && !loading && !activeDialog) {
          void load({ silent: true });
        }
      };

      refreshButton.addEventListener("click", () => {
        if (!loading && !mutating) void load({ silent: false, keepFeedback: false });
      });
      bannerRetry.addEventListener("click", () => {
        if (!loading && !mutating) void load({ silent: false, keepFeedback: false });
      });
      recoveryButton.addEventListener("click", openRecoveryDialog);
      document.addEventListener?.("visibilitychange", onVisibilityChange);

      void load({ silent: false });

      return () => {
        disposed = true;
        clearPollTimer();
        clearTimeout(copyResetTimer);
        document.removeEventListener?.("visibilitychange", onVisibilityChange);
        activeDialog?.remove();
        activeDialog = null;
      };
    },
  });
}

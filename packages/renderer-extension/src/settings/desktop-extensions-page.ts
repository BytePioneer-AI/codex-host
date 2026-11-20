import {
  type DesktopExtensionCategory,
  type DesktopExtensionMutationResult,
  type DesktopExtensionSelectionParams,
  type DesktopExtensionStatus,
  type DesktopExtensionsListResult,
  type DesktopExtensionsRecoveryParams,
} from "@codexhost/shared-contracts";
import { RendererMethodUnavailableError } from "../renderer-request-sender.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import {
  blockedToggleReason,
  createDesktopExtensionDetailModal,
  createEl,
  describeOtherExtension,
  extensionDescription,
  extensionDisplayName,
  extensionGroupOf,
  formatMessage,
  formatSlotLabel,
  isToggleBlocked,
  overlappingSlots,
  resolveAttentionDetail,
  statusTone,
  type DesktopExtensionFeedback,
  type DesktopExtensionGroupId,
  type DesktopExtensionItem,
} from "./desktop-extensions-detail-modal.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceSwitch, preferenceId } from "./preference-ui.js";

const POLL_INTERVAL_MS = 5_000;
const COPY_FEEDBACK_MS = 2_000;
const EXTENSIONS_ROOT_DISPLAY = "$CODEXHOST_DATA_DIR/desktop-extensions/";

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

const CATEGORY_ORDER: readonly DesktopExtensionCategory[] = [
  "sidebar",
  "composer",
  "conversation",
  "appearance",
  "tools",
  "workflow",
  "usage-analytics",
  "memory-knowledge",
  "integrations",
];

const EXTENSION_GROUP_ORDER: readonly DesktopExtensionGroupId[] = [
  "attention",
  "enabled",
  "disabled",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithinElement(target: EventTarget | null, container: HTMLElement): boolean {
  if (!target) return false;
  if (target === container) return true;
  if (
    typeof container.contains === "function" &&
    typeof Node !== "undefined" &&
    target instanceof Node
  ) {
    return container.contains(target);
  }
  return false;
}

function matchesSearchQuery(item: DesktopExtensionItem, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return true;
  const fields: string[] = [item.id];
  const manifest = item.manifest;
  if (manifest) {
    if (typeof manifest.name === "string") {
      fields.push(manifest.name);
    } else {
      fields.push(manifest.name.en, manifest.name["zh-CN"]);
    }
    if (manifest.author) {
      fields.push(manifest.author);
    }
    if (manifest.description) {
      fields.push(manifest.description.en);
      if (manifest.description["zh-CN"]) {
        fields.push(manifest.description["zh-CN"]);
      }
    }
    if (manifest.details) {
      fields.push(manifest.details.en);
      if (manifest.details["zh-CN"]) {
        fields.push(manifest.details["zh-CN"]);
      }
    }
  }
  const haystack = fields.join("\n").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function shouldShowStatusBadge(state: DesktopExtensionStatus["state"]): boolean {
  return state !== "disabled";
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

      // Persistent filter + search toolbar so typing never loses focus across renders/polls.
      const controlsBar = createEl(document, "div", "settings-extensions__toolbar");
      controlsBar.hidden = true;
      const categorySlot = createEl(document, "div", "settings-extensions__category-slot");
      categorySlot.hidden = true;
      const searchBox = createEl(document, "div", "settings-extensions__search");
      const searchIcon = createEl(document, "span", "settings-extensions__search-icon");
      searchIcon.append(createRendererSettingsIcon("search", 13));
      const searchInput = createEl(document, "input", "settings-extensions__search-input");
      searchInput.type = "search";
      searchInput.placeholder = copy.searchPlaceholder;
      searchInput.setAttribute("aria-label", copy.searchLabel);
      const clearSearchButton = createEl(document, "button", "settings-extensions__search-clear");
      clearSearchButton.type = "button";
      clearSearchButton.title = copy.clearSearch;
      clearSearchButton.setAttribute("aria-label", copy.clearSearch);
      clearSearchButton.hidden = true;
      clearSearchButton.append(createRendererSettingsIcon("close", 12));
      searchBox.append(searchIcon, searchInput, clearSearchButton);
      controlsBar.append(categorySlot, searchBox);

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

      root.append(header, metaBar, banner, diagnosticsPanel, controlsBar, body, recoverySection);
      context.content.append(root);

      let disposed = false;
      let listing: DesktopExtensionsListResult | null = null;
      let unavailable = false;
      let loading = false;
      let mutating = false;
      let activeMutationId: string | null = null;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let activeRecoveryDialog: HTMLDialogElement | null = null;
      let selectedCategory: DesktopExtensionCategory | null = null;
      let searchQuery = "";
      let currentFeedback: DesktopExtensionFeedback | null = null;
      let modalFeedbackExtensionId: string | null = null;

      const buildDetailModalState = () => ({
        extensions: listing?.extensions ?? [],
        unavailable,
        mutating,
        activeMutationId,
        feedback:
          modalFeedbackExtensionId !== null && modalFeedbackExtensionId === detailModal.extensionId
            ? currentFeedback
            : null,
      });

      const detailModal = createDesktopExtensionDetailModal({
        document,
        host: root,
        signal: context.signal,
        messages,
        onToggle: (item, enable) => {
          void toggleExtension(item, enable);
        },
        onClose: () => {
          modalFeedbackExtensionId = null;
        },
      });

      const setFeedback = (
        next: DesktopExtensionFeedback | null,
        modalExtensionId: string | null = null,
      ): void => {
        currentFeedback = next;
        modalFeedbackExtensionId = next ? modalExtensionId : null;
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

      const renderNoMatchesBox = (): void => {
        const empty = createEl(
          document,
          "div",
          "settings-remote__empty settings-extensions__empty settings-extensions__no-matches",
        );
        const copyBox = createEl(document, "div");
        copyBox.append(createEl(document, "strong", "", copy.noMatchesTitle));
        copyBox.append(createEl(document, "span", "", copy.noMatchesDescription));
        const resetButton = createEl(
          document,
          "button",
          "settings-command-button settings-command-button--secondary",
          copy.clearFilters,
        );
        resetButton.type = "button";
        resetButton.addEventListener("click", () => {
          selectedCategory = null;
          searchQuery = "";
          searchInput.value = "";
          clearSearchButton.hidden = true;
          render();
        });
        empty.append(copyBox, resetButton);
        body.replaceChildren(empty);
      };

      const renderExtensionCard = (
        item: DesktopExtensionItem,
        allExtensions: readonly DesktopExtensionItem[],
      ): HTMLElement => {
        const displayName = extensionDisplayName(item, messages.locale);
        const card = createEl(document, "article", "settings-extensions-card");
        card.dataset.extensionId = item.id;
        card.dataset.extensionState = item.status.state;
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.setAttribute("aria-haspopup", "dialog");
        card.setAttribute(
          "aria-label",
          formatMessage(copy.openDetailsLabel, { name: displayName }),
        );
        if (activeMutationId === item.id) card.dataset.busy = "true";

        const head = createEl(document, "div", "settings-extensions-card__head");
        const identity = createEl(document, "div", "settings-extensions-card__identity");

        // Row 1: bold title + compact category chips + active/attention status badge.
        const titleRow = createEl(document, "div", "settings-extensions-card__title");
        const nameEl = createEl(document, "h3", "", displayName);
        nameEl.title = displayName;
        titleRow.append(nameEl);

        if (item.manifest?.categories && item.manifest.categories.length > 0) {
          const categoriesRow = createEl(document, "div", "settings-extensions-categories");
          for (const category of item.manifest.categories) {
            const chip = createEl(
              document,
              "span",
              "settings-extensions-category-chip",
              copy.categories[category] ?? category,
            );
            chip.dataset.category = category;
            categoriesRow.append(chip);
          }
          titleRow.append(categoriesRow);
        }

        if (shouldShowStatusBadge(item.status.state)) {
          const badge = createEl(
            document,
            "span",
            "settings-extensions-badge",
            copy.states[item.status.state],
          );
          badge.dataset.state = item.status.state;
          badge.dataset.tone = statusTone(item.status.state);
          titleRow.append(badge);
        }

        identity.append(titleRow);

        // Row 2: single-line truncated description.
        const desc = extensionDescription(item, messages.locale);
        if (desc) {
          const descEl = createEl(document, "p", "settings-extensions-card__description", desc);
          descEl.title = desc;
          identity.append(descEl);
        }

        const controlColumn = createEl(document, "div", "settings-extensions-card__control");
        const switchId = preferenceId(`desktop-ext-${item.id}`);
        const errorId = preferenceId(`desktop-ext-error-${item.id}`);

        const blocked = isToggleBlocked(item);
        const toggle = createPreferenceSwitch(document, switchId, errorId);
        toggle.checked = item.enabled;
        toggle.setAttribute("aria-label", formatMessage(copy.toggleLabel, { name: displayName }));
        toggle.disabled = mutating || blocked;
        if (blocked) {
          toggle.title = blockedToggleReason(item, copy);
        }
        const stopRowTrigger = (event: Event): void => {
          event.stopPropagation?.();
        };
        controlColumn.addEventListener("click", stopRowTrigger);
        controlColumn.addEventListener("keydown", stopRowTrigger);
        toggle.addEventListener("click", stopRowTrigger);
        toggle.addEventListener("keydown", stopRowTrigger);
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

        // Attention states surface a concise single-row error inline below the main row.
        const attention = resolveAttentionDetail(item, allExtensions, messages.locale, copy);
        if (attention) {
          const detail = createEl(document, "div", "settings-extensions-card__detail");
          detail.id = errorId;
          detail.dataset.tone = attention.tone;
          detail.append(
            createRendererSettingsIcon("alert", 13),
            createEl(document, "span", "", attention.text),
          );
          card.append(detail);
        }

        const openDetails = (): void => {
          if (disposed || context.signal.aborted || activeRecoveryDialog) return;
          if (detailModal.extensionId !== item.id) {
            modalFeedbackExtensionId = null;
          }
          detailModal.open(item.id, buildDetailModalState());
        };
        card.addEventListener("click", (event) => {
          if (isWithinElement(event.target, controlColumn)) return;
          openDetails();
        });
        card.addEventListener("keydown", (event) => {
          if (isWithinElement(event.target, controlColumn)) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openDetails();
          }
        });

        return card;
      };

      const render = (): void => {
        syncToolbarState();
        renderConnectionState();
        renderDiagnostics();

        if (unavailable) {
          controlsBar.hidden = true;
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          renderEmptyBox(copy.unavailableTitle, copy.unavailableDescription);
          detailModal.sync(buildDetailModalState());
          return;
        }
        if (!listing) {
          controlsBar.hidden = true;
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          if (loading) renderLoading();
          else body.replaceChildren();
          detailModal.sync(buildDetailModalState());
          return;
        }
        if (listing.extensions.length === 0) {
          controlsBar.hidden = true;
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          renderEmptyBox(copy.emptyTitle, copy.emptyDescription, copy.emptyPathHint);
          detailModal.sync(buildDetailModalState());
          return;
        }

        const presentCategories = new Set<DesktopExtensionCategory>();
        for (const item of listing.extensions) {
          for (const category of item.manifest?.categories ?? []) {
            presentCategories.add(category);
          }
        }
        const availableCategories = CATEGORY_ORDER.filter((category) =>
          presentCategories.has(category),
        );
        if (selectedCategory && !presentCategories.has(selectedCategory)) {
          selectedCategory = null;
        }

        controlsBar.hidden = false;
        clearSearchButton.hidden = searchQuery.length === 0;
        if (availableCategories.length > 0) {
          const filterBar = createEl(document, "div", "settings-extensions__filters");
          filterBar.setAttribute("role", "group");
          filterBar.setAttribute("aria-label", copy.categoryFilterLabel);

          const addFilterPill = (
            label: string,
            category: DesktopExtensionCategory | null,
          ): void => {
            const pill = createEl(document, "button", "settings-extensions-filter-pill", label);
            pill.type = "button";
            pill.dataset.category = category ?? "all";
            pill.setAttribute("aria-pressed", String(selectedCategory === category));
            pill.addEventListener("click", () => {
              if (selectedCategory === category) return;
              selectedCategory = category;
              render();
            });
            filterBar.append(pill);
          };

          addFilterPill(copy.categoryAll, null);
          for (const category of availableCategories) {
            addFilterPill(copy.categories[category], category);
          }
          categorySlot.hidden = false;
          categorySlot.replaceChildren(filterBar);
        } else {
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
        }

        const normalizedQuery = searchQuery.trim().toLowerCase();
        const visibleExtensions = listing.extensions.filter((item) => {
          if (selectedCategory && !item.manifest?.categories?.includes(selectedCategory)) {
            return false;
          }
          return matchesSearchQuery(item, normalizedQuery);
        });

        if (visibleExtensions.length === 0) {
          renderNoMatchesBox();
          detailModal.sync(buildDetailModalState());
          return;
        }

        const buckets: Record<DesktopExtensionGroupId, DesktopExtensionItem[]> = {
          attention: [],
          enabled: [],
          disabled: [],
        };
        for (const item of visibleExtensions) {
          buckets[extensionGroupOf(item.status.state)].push(item);
        }

        const groupsContainer = createEl(document, "div", "settings-extensions__groups");
        groupsContainer.setAttribute("aria-label", messages.pageLabels["desktop-extensions"]);
        for (const groupId of EXTENSION_GROUP_ORDER) {
          const groupItems = buckets[groupId];
          if (groupItems.length === 0) continue;

          const section = createEl(document, "section", "settings-extensions__group");
          section.dataset.extensionGroup = groupId;
          const headingId = preferenceId(`desktop-ext-group-${groupId}`);
          section.setAttribute("aria-labelledby", headingId);

          const groupHead = createEl(document, "div", "settings-extensions__group-head");
          const groupTitle = createEl(
            document,
            "h2",
            "settings-extensions__group-title",
            copy.groups[groupId],
          );
          groupTitle.id = headingId;
          const groupCount = createEl(
            document,
            "span",
            "settings-extensions__group-count",
            String(groupItems.length),
          );
          groupHead.append(groupTitle, groupCount);

          const list = createEl(document, "div", "settings-extensions__list");
          for (const item of groupItems) {
            list.append(renderExtensionCard(item, listing.extensions));
          }
          section.append(groupHead, list);
          groupsContainer.append(section);
        }

        body.replaceChildren(groupsContainer);
        detailModal.sync(buildDetailModalState());
      };

      const clearPollTimer = (): void => {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      };

      const schedulePoll = (): void => {
        clearPollTimer();
        if (disposed || context.signal.aborted || document.visibilityState === "hidden") return;
        pollTimer = setTimeout(() => {
          if (disposed || context.signal.aborted || mutating || loading || activeRecoveryDialog) {
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
        const displayName = extensionDisplayName(item, messages.locale);
        const modalTargetId = detailModal.extensionId === item.id ? item.id : null;
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
            setFeedback(
              {
                tone: "success",
                text: formatMessage(enable ? copy.savedEnabled : copy.savedDisabled, {
                  name: displayName,
                }),
              },
              modalTargetId,
            );
            mutating = false;
            activeMutationId = null;
            render();
            await load({ silent: true, keepFeedback: true });
            return;
          }

          if (result.state === "slot-conflict") {
            const allExtensions = listing?.extensions ?? [];
            const other = describeOtherExtension(
              result.conflictWith,
              allExtensions,
              messages.locale,
            );
            const shared = overlappingSlots(item, result.conflictWith, allExtensions);
            setFeedback(
              {
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
              },
              modalTargetId,
            );
            return;
          }

          if (result.state === "revision-conflict") {
            setFeedback(
              {
                tone: "warning",
                text: copy.revisionConflictBanner,
              },
              modalTargetId,
            );
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
          setFeedback(
            {
              tone: "danger",
              text: formatMessage(copy.actionFailed, { message: errorMessage(error) }),
            },
            modalTargetId,
          );
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
        if (disposed || context.signal.aborted || mutating || activeRecoveryDialog) return;
        const client = resolveAvailableClient(getClient);
        if (!client?.disableAllDesktopExtensionsAndReload) return;
        detailModal.close();

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
          if (activeRecoveryDialog === modal) activeRecoveryDialog = null;
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

        activeRecoveryDialog = modal;
        root.append(modal);
        modal.showModal();
      };

      const onVisibilityChange = (): void => {
        if (document.visibilityState === "hidden") clearPollTimer();
        else if (
          !disposed &&
          !context.signal.aborted &&
          !mutating &&
          !loading &&
          !activeRecoveryDialog
        ) {
          void load({ silent: true });
        }
      };

      searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value;
        clearSearchButton.hidden = searchQuery.length === 0;
        render();
      });
      clearSearchButton.addEventListener("click", () => {
        searchQuery = "";
        searchInput.value = "";
        clearSearchButton.hidden = true;
        render();
        searchInput.focus?.();
      });

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
        detailModal.dispose();
        activeRecoveryDialog?.remove();
        activeRecoveryDialog = null;
      };
    },
  });
}

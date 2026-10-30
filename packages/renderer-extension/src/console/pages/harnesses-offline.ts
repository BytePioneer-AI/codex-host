import { consoleGet, consolePost } from "../api.js";
import { button, h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import { createRendererSettingsIcon } from "../../settings/icons.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "../../settings/core.js";

interface ConsoleHarness {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  launchCommand: boolean;
  links: { documentation?: string; installation?: string } | null;
  icon: string | null;
  launchPath: string | null;
}

/**
 * Harness list while codexhost is not running: manifests and installation
 * paths only, read and written by the console without the Host.
 */
export function createOfflineHarnessesPage(
  messages: ConsoleMessages,
  label: string,
  codexhostRunning: () => boolean,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "connections",
    label,
    icon: "connections" as const,
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const list = h(document, "div", { className: "console-harness-list" });
      const status = new Map<string, string>();
      let harnesses: ConsoleHarness[] = [];
      const render = (): void => {
        if (harnesses.length === 0) {
          list.replaceChildren(
            h(document, "p", { className: "console-muted" }, messages.noHarness),
          );
          return;
        }
        list.replaceChildren(
          ...harnesses.map((harness) => {
            const guide = harness.links?.installation ?? harness.links?.documentation;
            const identity = h(
              document,
              "div",
              { className: "console-harness__identity" },
              harness.icon
                ? h(document, "img", {
                    className: "console-harness__icon",
                    src: harness.icon,
                    alt: "",
                  })
                : h(document, "span", { className: "console-harness__icon is-placeholder" }),
              h(
                document,
                "div",
                {},
                h(document, "div", { className: "console-harness__name" }, harness.name),
                h(
                  document,
                  "div",
                  { className: "console-muted" },
                  `${harness.id} · ${harness.version}`,
                ),
              ),
              h(
                document,
                "span",
                { className: `console-badge is-${harness.enabled ? "ok" : "info"}` },
                harness.enabled ? messages.enabled : messages.disabled,
              ),
            );
            const row = h(document, "div", { className: "console-harness" }, identity);
            if (harness.launchCommand) {
              const input = h(document, "input", {
                type: "text",
                className: "console-input",
                placeholder: messages.installPathAuto,
                "aria-label": `${harness.name} ${messages.installPath}`,
                value: harness.launchPath ?? "",
              });
              const submit = (path: string | null): void => {
                status.delete(harness.id);
                void consolePost<{ harness: ConsoleHarness }>("/api/harnesses/launch-path", {
                  id: harness.id,
                  path,
                })
                  .then(({ harness: saved }) => {
                    harnesses = harnesses.map((entry) => (entry.id === saved.id ? saved : entry));
                    status.set(harness.id, messages.saved);
                  })
                  .catch((error: unknown) =>
                    status.set(harness.id, error instanceof Error ? error.message : String(error)),
                  )
                  .finally(render);
              };
              row.append(
                h(
                  document,
                  "div",
                  { className: "console-harness__path" },
                  input,
                  button(document, messages.save, () => submit(input.value.trim() || null)),
                  harness.launchPath
                    ? button(document, messages.useAutomatic, () => submit(null))
                    : null,
                ),
              );
              if (status.has(harness.id)) {
                row.append(
                  h(document, "div", { className: "console-muted" }, status.get(harness.id) ?? ""),
                );
              }
            }
            if (guide) {
              identity.append(
                h(
                  document,
                  "a",
                  {
                    className: "console-link",
                    href: guide,
                    target: "_blank",
                    rel: "noopener noreferrer",
                  },
                  messages.installGuide,
                  createRendererSettingsIcon("external-link", 13),
                ),
              );
            }
            return row;
          }),
        );
      };
      context.content.replaceChildren(
        h(document, "h1", { className: "settings-section-label" }, label),
        h(
          document,
          "div",
          { className: "console-notice" },
          createRendererSettingsIcon("info", 16),
          h(
            document,
            "span",
            {},
            codexhostRunning() ? messages.offlineHarnessUnreachable : messages.offlineHarnessNote,
          ),
        ),
        list,
      );
      void context.runLatest(
        (signal) => consoleGet<{ harnesses: ConsoleHarness[] }>("/api/harnesses", signal),
        {
          success(value) {
            harnesses = value.harnesses;
            render();
          },
          failure(error) {
            list.replaceChildren(
              h(
                document,
                "p",
                { className: "console-muted" },
                error instanceof Error ? error.message : String(error),
              ),
            );
          },
        },
      );
      return undefined;
    },
  });
}

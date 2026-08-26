export type OmpExtensionUiRequest =
  | {
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | { id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | {
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { id: string; method: "setTitle"; title: string }
  | { id: string; method: "set_editor_text"; text: string }
  | {
      id: string;
      method: "open_url";
      url: string;
      launchUrl?: string;
      instructions?: string;
    };

export interface OmpExtensionUiHandlers {
  notify?(request: Extract<OmpExtensionUiRequest, { method: "notify" }>): void | Promise<void>;
  setStatus?(
    request: Extract<OmpExtensionUiRequest, { method: "setStatus" }>,
  ): void | Promise<void>;
  setWidget?(
    request: Extract<OmpExtensionUiRequest, { method: "setWidget" }>,
  ): void | Promise<void>;
  setTitle?(request: Extract<OmpExtensionUiRequest, { method: "setTitle" }>): void | Promise<void>;
  setEditorText?(
    request: Extract<OmpExtensionUiRequest, { method: "set_editor_text" }>,
  ): void | Promise<void>;
  openUrl?(request: Extract<OmpExtensionUiRequest, { method: "open_url" }>): void | Promise<void>;
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseOmpExtensionUiRequest(
  value: Record<string, unknown>,
): OmpExtensionUiRequest | null {
  if (!nonBlankString(value.id) || value.type !== "extension_ui_request") return null;
  switch (value.method) {
    case "notify":
      return nonBlankString(value.message)
        ? {
            id: value.id,
            method: "notify",
            message: value.message,
            ...(value.notifyType === "info" ||
            value.notifyType === "warning" ||
            value.notifyType === "error"
              ? { notifyType: value.notifyType }
              : {}),
          }
        : null;
    case "setStatus":
      return nonBlankString(value.statusKey) &&
        (value.statusText === undefined || typeof value.statusText === "string")
        ? {
            id: value.id,
            method: "setStatus",
            statusKey: value.statusKey,
            ...(typeof value.statusText === "string" ? { statusText: value.statusText } : {}),
          }
        : null;
    case "setWidget":
      return nonBlankString(value.widgetKey) &&
        (value.widgetLines === undefined ||
          (Array.isArray(value.widgetLines) &&
            value.widgetLines.every((line) => typeof line === "string")))
        ? {
            id: value.id,
            method: "setWidget",
            widgetKey: value.widgetKey,
            ...(Array.isArray(value.widgetLines) ? { widgetLines: [...value.widgetLines] } : {}),
            ...(value.widgetPlacement === "aboveEditor" || value.widgetPlacement === "belowEditor"
              ? { widgetPlacement: value.widgetPlacement }
              : {}),
          }
        : null;
    case "setTitle":
      return typeof value.title === "string"
        ? { id: value.id, method: "setTitle", title: value.title }
        : null;
    case "set_editor_text":
      return typeof value.text === "string"
        ? { id: value.id, method: "set_editor_text", text: value.text }
        : null;
    case "open_url":
      return nonBlankString(value.url) &&
        (value.launchUrl === undefined || typeof value.launchUrl === "string") &&
        (value.instructions === undefined || typeof value.instructions === "string")
        ? {
            id: value.id,
            method: "open_url",
            url: value.url,
            ...(typeof value.launchUrl === "string" ? { launchUrl: value.launchUrl } : {}),
            ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
          }
        : null;
    default:
      return null;
  }
}

export async function dispatchOmpExtensionUi(
  request: OmpExtensionUiRequest,
  handlers: OmpExtensionUiHandlers | undefined,
): Promise<void> {
  if (!handlers) return;
  switch (request.method) {
    case "notify":
      await handlers.notify?.(request);
      return;
    case "setStatus":
      await handlers.setStatus?.(request);
      return;
    case "setWidget":
      await handlers.setWidget?.(request);
      return;
    case "setTitle":
      await handlers.setTitle?.(request);
      return;
    case "set_editor_text":
      await handlers.setEditorText?.(request);
      return;
    case "open_url":
      await handlers.openUrl?.(request);
      return;
  }
}

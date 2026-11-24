/**
 * The failure line one Remote code deserves.
 *
 * Kept apart from the component so the mapping is testable on its own. Codes
 * this reader does not name fall to the generic line carrying the carrier's
 * message.
 */
import type { RemoteFailure } from "@deepseek-ai/dsh-api-remotes/client";
import type { TranslateNS } from "@deepseek-ai/dsh-client-locale/client";
import type { SidebarDocumentPreviewKey } from "./locales.ts";

/** Subset of the `remoteHost` session projection needed to gate workspace file previews upfront. */
export interface RemoteHostWorkspaceCapabilities {
  readonly hostId: string;
  readonly state: string;
  readonly workspaceFiles?: boolean;
  readonly officePreview?: boolean;
}

/**
 * Return an upfront localized error key when a remote session's projected capabilities
 * already indicate that workspace file preview is unavailable (e.g. legacy Peer or offline host).
 */
export function remoteWorkspacePreviewBlockKey(
  sessionId: string,
  remoteHost: RemoteHostWorkspaceCapabilities | null | undefined,
): SidebarDocumentPreviewKey | undefined {
  if (remoteHost == null) return undefined;
  if (remoteHost.state !== "connected") return "error.remoteOffline";
  if (remoteHost.workspaceFiles === false) {
    if (sessionId.startsWith("web-remote:draft-")) return "error.remoteDraftUnsubmitted";
    return remoteHost.hostId.startsWith("remote-peer:")
      ? "error.remoteUpgradeRequired"
      : "error.remoteUnsupported";
  }
  return undefined;
}

/** Render a byte count the way a person reads one. */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function failureReason(failure: RemoteFailure): string | undefined {
  const details = failure.details as { readonly reason?: unknown } | undefined;
  return typeof details?.reason === "string" ? details.reason : undefined;
}

/**
 * Say what went wrong, in terms of the file rather than of the transport.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show in place of the file.
 */
export function failureLine(
  t: TranslateNS<"sidebarDocumentPreview">,
  failure: RemoteFailure,
): string {
  switch (failure.code) {
    case "workspace-file/not-found":
      return t("error.notFound");
    case "workspace-file/too-large":
      return t("error.tooLarge", { limit: humanBytes(failure.details.limit) });
    case "workspace-file/not-text":
      return t("error.notText");
    case "workspace-file/not-regular-file":
      return t("error.notRegularFile");
    case "workspace-file/outside-workspace":
      return t("error.outsideWorkspace");
    // Carrier and unclassified host failures reach the reader as themselves:
    // this panel knows nothing useful to add to a transport-level message.
    default: {
      const code: string = failure.code;
      if (code === "remote/workspace-files-unsupported") {
        const reason = failureReason(failure);
        if (reason === "upgrade-required") return t("error.remoteUpgradeRequired");
        if (reason === "unsubmitted-draft") return t("error.remoteDraftUnsubmitted");
        return t("error.remoteUnsupported");
      }
      if (code === "remote/office-preview-unsupported") return t("error.remoteOfficeUnsupported");
      if (code === "remote/offline") return t("error.remoteOffline");
      if (code === "remote/timeout") return t("error.remoteTimeout");
      return t("error.unavailable", { message: failure.message });
    }
  }
}

/** The action an empty preview offers beside its failure line. */
export type EmptyFailureRecourse = "open" | "retry" | "none";

/**
 * Choose the empty state's action for one settled read failure.
 * @param failure - the settled Remote failure.
 * @returns `open` for a readable file this preview cannot render, `none` for a
 * path with nothing to show or open, `retry` for the rest: carrier and
 * unclassified failures a second read may resolve.
 */
export function emptyFailureRecourse(failure: RemoteFailure): EmptyFailureRecourse {
  switch (failure.code) {
    case "workspace-file/not-text":
    case "workspace-file/too-large":
      return "open";
    case "workspace-file/not-found":
    case "workspace-file/not-regular-file":
    case "workspace-file/outside-workspace":
      return "none";
    default: {
      const code: string = failure.code;
      if (
        code === "remote/workspace-files-unsupported" ||
        code === "remote/office-preview-unsupported"
      ) {
        return "none";
      }
      return "retry";
    }
  }
}

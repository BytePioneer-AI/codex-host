/** Map Host asset-check failures to locale copy. Other errors keep the server message. */
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";

type Translate = PropsLocale<"codexhostImport">["t"];

const MISSING_MODULE =
  /^web-assets: \S+ requires (\S+)@(.+), but the browser Host does not provide \1$/u;
const VERSION_MISMATCH =
  /^web-assets: \S+ requires (\S+)@(.+), but the browser Host provides (.+)$/u;
const SNAPSHOT_MISSING =
  /^web-assets: \S+ declares runtime version requirements, but the browser Host version snapshot is unavailable$/u;
const MISSING_BROWSER_MODULE = /^web-assets: \S+ requires unavailable browser module (\S+)$/u;

export function formatWebExtensionError(message: string, t: Translate): string {
  if (MISSING_MODULE.test(message) || MISSING_BROWSER_MODULE.test(message))
    return t("extensions.unsupported");
  if (VERSION_MISMATCH.test(message)) return t("extensions.versionMismatch");
  if (SNAPSHOT_MISSING.test(message)) return t("extensions.hostVersionSnapshotMissing");
  return message.replace(/^web-assets:\s+/u, "");
}

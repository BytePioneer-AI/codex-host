/** The Host restores this public carrier after Web attachment context is prepared. */
import { harnessCommandMentionPath } from "@codexhost/shared-contracts";

export const HARNESS_COMMAND_SOURCE = "codexhost-native";

export function harnessCommandReference(
  invocation: string,
  kind: "command" | "skill" = "command",
  name = invocation,
) {
  const path = harnessCommandMentionPath(invocation, kind);
  const label = (
    kind === "skill" ? name.replace(/^\/?skill:/iu, "").replace(/^[$/]/u, "") : invocation
  ).replace(/[\[\]\r\n]/gu, " ");
  const ref = `[@${label}](${path})`;
  return {
    source: HARNESS_COMMAND_SOURCE,
    ref,
    label,
    clipboardText: ref,
    ...(kind === "skill" ? { appearance: "skill" as const } : {}),
  };
}

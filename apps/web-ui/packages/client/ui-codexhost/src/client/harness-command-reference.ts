/** The Host restores this public carrier after Web attachment context is prepared. */
import { harnessCommandMentionPath } from "@codexhost/shared-contracts";

export const HARNESS_COMMAND_SOURCE = "codexhost-native";

export function harnessCommandReference(invocation: string) {
  const path = harnessCommandMentionPath(invocation);
  const label = invocation.replace(/[\[\]\r\n]/gu, " ");
  const ref = `[@${label}](${path})`;
  return { source: HARNESS_COMMAND_SOURCE, ref, label: invocation, clipboardText: ref };
}

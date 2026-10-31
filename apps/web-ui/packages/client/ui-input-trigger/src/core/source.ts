import type { InputTriggerSource } from "../types.ts";

/** Menu aliases share one registered source, codec and subscription lifecycle. */
export function sourceMatchesTrigger(
  source: Pick<InputTriggerSource, "trigger" | "aliases">,
  trigger: string,
): boolean {
  return source.trigger === trigger || source.aliases?.some((alias) => alias === trigger) === true;
}

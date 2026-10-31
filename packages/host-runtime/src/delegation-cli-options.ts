import { DelegationControlError } from "./delegation-types.js";

/** Options whose value is user text: the next argument is taken verbatim, even empty or dash-leading. */
const FREE_TEXT_OPTIONS: ReadonlySet<string> = new Set(["--task", "--task-name", "--message"]);

export interface DelegationCliArguments {
  positionals: string[];
  options: Map<string, string>;
}

/**
 * Whether `argument` consumes the argument after it as its value. `--name=value` never does.
 * Other options take the next argument unless it looks like another option, so a forgotten
 * value is reported instead of swallowing the following option.
 */
export function consumesNextArgument(argument: string, next: string | undefined): boolean {
  if (!argument.startsWith("--") || argument.includes("=")) return false;
  if (FREE_TEXT_OPTIONS.has(argument)) return true;
  return next !== undefined && !next.startsWith("--");
}

export function parseDelegationArguments(arguments_: readonly string[]): DelegationCliArguments {
  const positionals: string[] = [];
  const parsed = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (parsed.has(name))
      throw new DelegationControlError("INVALID_ARGUMENT", `${name} may only be provided once`);
    let optionValue: string | undefined;
    if (separator !== -1) {
      optionValue = argument.slice(separator + 1);
    } else if (consumesNextArgument(argument, arguments_[index + 1])) {
      optionValue = arguments_[index + 1];
      index += 1;
    }
    if (optionValue === undefined || (optionValue === "" && !FREE_TEXT_OPTIONS.has(name)))
      throw new DelegationControlError("INVALID_ARGUMENT", `${name} requires a value`);
    parsed.set(name, optionValue);
  }
  return { positionals, options: parsed };
}

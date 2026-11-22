import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

import { DelegationControlError } from "./delegation-types.js";

/** Bounds raw input and leaves room for JSON escaping within the Runtime's 2 MiB request limit. */
export const MAX_CLI_TEXT_INPUT_BYTES = 256 * 1024;

export async function resolveCliTextInput(
  options: ReadonlyMap<string, string>,
  name: "--task" | "--message",
  stdin: Readable & { isTTY?: boolean } = process.stdin,
): Promise<string | undefined> {
  const fileOption = `${name}-file`;
  const file = options.get(fileOption);
  if (file === undefined) return options.get(name);
  if (options.has(name))
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `${name} and ${fileOption} are mutually exclusive`,
    );
  if (file === "-" && stdin.isTTY)
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `${fileOption} - requires piped stdin; use a quoted heredoc (<<'EOF'), not a terminal`,
    );
  const source = file === "-" ? stdin : createReadStream(file);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_CLI_TEXT_INPUT_BYTES)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          `${fileOption} input exceeds ${MAX_CLI_TEXT_INPUT_BYTES} bytes (256 KiB)`,
        );
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof DelegationControlError) throw error;
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `Cannot read ${fileOption} ${JSON.stringify(file)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/u, "");
  if (!text.trim())
    throw new DelegationControlError("INVALID_ARGUMENT", `${fileOption} input must not be empty`);
  return text;
}

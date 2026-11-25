import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

/** --serve also prints a native banner containing its password; only JSON enters ACP. */
export function codeBuddyAcpOutput(stdout: Readable, onLine?: (line: string) => void): Readable {
  return Readable.from(
    (async function* () {
      for await (const line of createInterface({ input: stdout })) {
        onLine?.(stripVTControlCharacters(line));
        if (line.trimStart().startsWith("{")) yield Buffer.from(`${line}\n`);
      }
    })(),
  );
}

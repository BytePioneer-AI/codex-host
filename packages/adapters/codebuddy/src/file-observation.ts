import { readFile, realpath, stat } from "node:fs/promises";
import { CodeBuddyError } from "./common.js";

export interface CodeBuddyFileVersion {
  realFile: string;
  fingerprint: string;
  size: number;
}

export async function codeBuddyFileVersion(file: string): Promise<CodeBuddyFileVersion> {
  const [realFile, value] = await Promise.all([realpath(file), stat(file, { bigint: true })]);
  return {
    realFile,
    fingerprint: `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`,
    size: Number(value.size),
  };
}

export function sameCodeBuddyFileVersion(
  left: CodeBuddyFileVersion | undefined,
  right: CodeBuddyFileVersion | undefined,
) {
  return Boolean(
    left && right && left.realFile === right.realFile && left.fingerprint === right.fingerprint,
  );
}

export async function readCodeBuddyVersionedText(
  file: string,
  maximumBytes: number,
  tooLargeMessage: string,
  before?: CodeBuddyFileVersion,
) {
  const observedBefore = before ?? (await codeBuddyFileVersion(file));
  if (observedBefore.size > maximumBytes) throw new CodeBuddyError("unsupported", tooLargeMessage);
  const contents = await readFile(file, "utf8"),
    after = await codeBuddyFileVersion(file),
    bytesRead = Buffer.byteLength(contents),
    reusableVersion =
      sameCodeBuddyFileVersion(observedBefore, after) && bytesRead === after.size
        ? after
        : undefined;
  if (bytesRead > maximumBytes || after.size > maximumBytes)
    throw new CodeBuddyError("unsupported", tooLargeMessage);
  return { contents, reusableVersion };
}

import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonObject } from "@codexhost/protocol-core";
import { externalTurnInputText, MissingExternalImagePathsError } from "./external-turn-input.js";

const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
};
const maxImageBytes = 20 * 1024 * 1024;
const maxTotalBytes = 32 * 1024 * 1024;

/** Materialize Desktop inline images only when their native paths are missing. */
export async function materializeExternalImages(
  input: JsonObject[],
  environment: NodeJS.ProcessEnv,
): Promise<JsonObject[]> {
  try {
    externalTurnInputText(input);
    return input;
  } catch (error) {
    if (!(error instanceof MissingExternalImagePathsError)) throw error;
  }
  const images = input.filter((item) => item.type === "image");
  if (images.length > 20) throw new Error("Too many image attachments (maximum 20)");
  let total = 0;
  const files = images.map((image) => {
    const match =
      typeof image.url === "string"
        ? /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(image.url)
        : null;
    const extension = match && extensions[match[1] ?? ""];
    const encoded = match?.[2] ?? "";
    if (!extension || !encoded || encoded.length % 4 !== 0)
      throw new Error("Image attachment must contain a supported base64 image");
    if (encoded.length > Math.ceil(maxImageBytes / 3) * 4)
      throw new Error("Image attachment exceeds 20 MiB");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > maxImageBytes || bytes.toString("base64") !== encoded)
      throw new Error("Image attachment is invalid or exceeds 20 MiB");
    total += bytes.length;
    if (total > maxTotalBytes) throw new Error("Image attachments exceed 32 MiB");
    return { bytes, name: `${createHash("sha256").update(bytes).digest("hex")}.${extension}` };
  });
  const home = environment.CODEX_HOME ?? path.join(environment.HOME ?? os.homedir(), ".codex");
  const directory = path.resolve(home, "attachments", "codexhost-inline");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const file of files) {
    const destination = path.join(directory, file.name);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, file.bytes, { mode: 0o600, flag: "wx" });
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (
          !(await lstat(destination)).isFile() ||
          !(await readFile(destination)).equals(file.bytes)
        )
          throw new Error("Existing image attachment is invalid");
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    paths.push(destination);
  }
  let index = 0;
  return input.map((item) =>
    item.type === "image" ? { type: "localImage", path: paths[index++] as string } : item,
  );
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const DEFAULT_PET_KEY = "builtin:codexhost-otter";

export async function loadBuiltinPet() {
  const image = await readFile(new URL("../assets/codexhost-otter.svg", import.meta.url));
  return {
    image,
    pet: {
      key: DEFAULT_PET_KEY,
      id: "codexhost-otter",
      name: "CodexHost Otter",
      market: "CodexHost",
      author: "CodexHost contributors",
      sourceUrl: "https://github.com/BytePioneer-AI/codex-host",
      license: "LGPL-3.0-only",
      builtin: true,
      renderer: "otter",
      mime: "image/svg+xml",
      bytes: image.length,
      digest: createHash("sha256").update(image).digest("hex"),
      manifest: { id: "codexhost-otter", displayName: "CodexHost Otter" },
      licenses: [],
    },
  };
}

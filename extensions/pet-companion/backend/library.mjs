import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPetArchive } from "./archive.mjs";
import { DEFAULT_PET_KEY, loadBuiltinPet } from "./builtin.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const MAX_PETS = 64;

export async function createLibrary(dataDir) {
  const builtin = await loadBuiltinPet();
  const directory = path.join(dataDir, "pets");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pets = new Map();
  const filename = (key, suffix) => path.join(directory, `${hash(key)}.${suffix}`);
  const spritePath = (pet) => path.join(directory, `${pet.digest}.sprite`);
  const read = async (file, limit) => {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
      throw new Error("Invalid local pet file");
    return readFile(file);
  };
  const atomic = async (file, bytes) => {
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  for (const entry of (await readdir(directory, { withFileTypes: true })).slice(0, 256)) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name) || pets.size >= MAX_PETS)
      continue;
    try {
      const pet = JSON.parse(
        (await read(path.join(directory, entry.name), 256 * 1024)).toString("utf8"),
      );
      if (
        typeof pet.key !== "string" ||
        pet.key === DEFAULT_PET_KEY ||
        typeof pet.name !== "string" ||
        !/^[a-f0-9]{64}$/u.test(pet.digest) ||
        filename(pet.key, "json") !== path.join(directory, entry.name)
      )
        continue;
      const bytes = await read(spritePath(pet), 8 * 1024 * 1024);
      if (hash(bytes) !== pet.digest) continue;
      pets.set(pet.key, pet);
    } catch {
      continue;
    }
  }
  return {
    list: () => [builtin.pet, ...pets.values()],
    get: (key) => (key === DEFAULT_PET_KEY ? builtin.pet : pets.get(key)),
    async install(pet, zip) {
      if (pet.key === DEFAULT_PET_KEY) throw new Error("The built-in pet cannot be replaced");
      if (!pets.has(pet.key) && pets.size >= MAX_PETS)
        throw new Error("Your library is full (64 pets). Remove a pet before downloading another.");
      const parsed = await readPetArchive(zip);
      const previous = pets.get(pet.key);
      const record = {
        ...pet,
        name:
          typeof parsed.manifest.displayName === "string"
            ? parsed.manifest.displayName.slice(0, 128)
            : pet.name,
        version: parsed.version,
        mime: parsed.mime,
        bytes: parsed.image.length,
        digest: hash(parsed.image),
        manifest: parsed.manifest,
        licenses: parsed.licenses,
        license:
          pet.license ||
          (typeof parsed.manifest.license === "string"
            ? parsed.manifest.license.slice(0, 1024)
            : ""),
        installedAt: new Date().toISOString(),
      };
      await atomic(spritePath(record), parsed.image);
      await atomic(filename(pet.key, "json"), JSON.stringify(record));
      pets.set(pet.key, record);
      if (
        previous &&
        previous.digest !== record.digest &&
        ![...pets.values()].some((entry) => entry.digest === previous.digest)
      )
        await rm(spritePath(previous), { force: true }).catch(() => undefined);
      return record;
    },
    async sprite(key) {
      if (key === DEFAULT_PET_KEY) return builtin.image;
      if (!pets.has(key)) throw new Error("Pet is not installed");
      return read(spritePath(pets.get(key)), 8 * 1024 * 1024);
    },
    async remove(key) {
      if (key === DEFAULT_PET_KEY) throw new Error("The built-in pet cannot be removed");
      if (!pets.has(key)) return;
      const pet = pets.get(key);
      await rm(filename(key, "json"), { force: true });
      pets.delete(key);
      if (![...pets.values()].some((entry) => entry.digest === pet.digest))
        await rm(spritePath(pet), { force: true });
    },
  };
}

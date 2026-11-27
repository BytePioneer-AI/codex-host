import { json, marketUrl, text as readMarketText } from "./network.mjs";
import { readGallery } from "./gallery.mjs";

export const markets = [
  { id: "codex-pets", name: "Codex Pets", url: "https://codex-pets.net/" },
  { id: "petdex", name: "Petdex", url: "https://petdex.dev/" },
  { id: "codexpets", name: "CodexPets.net", url: "https://codexpets.net/" },
];
const text = (value, limit = 300) => (typeof value === "string" ? value.slice(0, limit) : "");

export function normalizePet(market, row) {
  const source = markets.find((value) => value.id === market);
  if (!source || !row || typeof row !== "object") throw new Error("Invalid market entry");
  const id = text(row.id ?? row.slug, 128);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u.test(id)) throw new Error("Invalid market pet ID");
  const sprite = marketUrl(row.spritesheetUrl ?? row.spritesheetPath, source.url);
  const downloadUrl = row.downloadUrl ?? row.zipUrl;
  if (typeof downloadUrl !== "string") return null;
  return {
    key: `${market}:${id}`,
    id,
    market,
    name: text(row.displayName, 128) || id,
    description: text(row.description, 1024),
    author: text(row.ownerName ?? row.ownerHandle ?? row.submittedBy?.name ?? row.author, 128),
    license: text(row.license ?? row.licenseName, 1024),
    sourceUrl:
      market === "codexpets"
        ? marketUrl(row.detailHref, source.url)
        : new URL(
            `${market === "codex-pets" ? "#/" : ""}pets/${encodeURIComponent(id)}`,
            source.url,
          ).href,
    downloadUrl: marketUrl(downloadUrl, source.url),
    previewUrl:
      market === "petdex"
        ? `https://assets.petdex.dev/pets/${encodeURIComponent(id)}/thumb.webp`
        : market === "codexpets"
          ? sprite
          : marketUrl(row.previewUrl ?? row.posterUrl ?? sprite, source.url),
    spritesheetUrl: sprite,
    spriteVersionNumber: row.spriteVersionNumber === 2 ? 2 : 1,
  };
}

export async function searchMarket({ market = "codex-pets", query = "", page = 1 } = {}, signal) {
  if (!markets.some((entry) => entry.id === market)) throw new Error("Unknown market");
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10_000 ||
    typeof query !== "string" ||
    query.length > 160
  )
    throw new Error("Invalid market search");
  if (market === "codexpets") {
    const html = await readMarketText("https://codexpets.net/gallery", {
      signal,
      limit: 4 * 1024 * 1024,
    });
    const rows = readGallery(html);
    const filtered = rows.filter(
      (row) =>
        !query.trim() ||
        `${row.displayName} ${row.description} ${row.tags}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    );
    const start = (page - 1) * 12;
    return {
      pets: filtered.slice(start, start + 12).flatMap((row) => {
        try {
          const pet = normalizePet(market, row);
          return pet ? [pet] : [];
        } catch {
          return [];
        }
      }),
      page,
      total: filtered.length,
      hasMore: start + 12 < filtered.length,
    };
  }
  const url =
    market === "codex-pets"
      ? new URL("https://codex-pets.net/api/pets")
      : new URL("https://petdex.dev/api/pets/search");
  url.searchParams.set("sort", "popular");
  url.searchParams.set("q", query.trim());
  if (market === "codex-pets") {
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", "12");
  } else {
    url.searchParams.set("limit", "12");
    url.searchParams.set("cursor", String((page - 1) * 12));
  }
  const payload = await json(url.href, { signal });
  if (!Array.isArray(payload.pets)) throw new Error("The market returned an invalid listing");
  const pets = payload.pets.slice(0, 12).flatMap((row) => {
    try {
      const pet = normalizePet(market, row);
      return pet ? [pet] : [];
    } catch {
      return [];
    }
  });
  return {
    pets,
    page,
    total: Number.isSafeInteger(payload.total) ? payload.total : null,
    hasMore:
      market === "codex-pets"
        ? page < payload.totalPages
        : payload.nextCursor !== null && payload.nextCursor !== undefined,
  };
}

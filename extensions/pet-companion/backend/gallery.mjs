export function readGallery(html) {
  const rows = new Map();
  let visited = 0;
  const visit = (value) => {
    if (!value || typeof value !== "object" || ++visited > 20_000) return;
    if (
      value.pet &&
      typeof value.pet.slug === "string" &&
      typeof value.pet.downloadHref === "string"
    ) {
      const pet = value.pet;
      if (rows.size < 512)
        rows.set(pet.slug, {
          slug: pet.slug,
          displayName: pet.name,
          description: pet.description,
          tags: Array.isArray(pet.tags) ? pet.tags.join(" ") : "",
          ownerName: pet.contributorName,
          spritesheetUrl: pet.spritesheetUrl,
          detailHref: pet.detailHref,
          downloadUrl: pet.downloadHref,
        });
    }
    for (const child of Object.values(value)) visit(child);
  };
  const frames = [];
  for (const match of html.matchAll(/<script>self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
    try {
      const frame = JSON.parse(match[1]);
      if (frame[0] !== 1 || typeof frame[1] !== "string") continue;
      frames.push(frame[1]);
    } catch {}
  }
  for (const line of frames.join("").split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    try {
      visit(JSON.parse(line.slice(separator + 1)));
    } catch {}
  }
  if (!rows.size)
    throw new Error(
      "The gallery format has changed. Open the market website or try another market.",
    );
  return [...rows.values()];
}

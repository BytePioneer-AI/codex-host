import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContentLoader, type SiteConfig } from "vitepress";

export async function generateLlms(config: SiteConfig): Promise<void> {
  const pages = await createContentLoader(["docs/**/*.md", "en/docs/**/*.md"], {
    includeSrc: true,
  }).load();
  pages.sort((a, b) => a.url.localeCompare(b.url, "en"));

  const index = [
    "# CodexHost",
    "> Run local coding agents inside Codex Desktop and the Web UI.",
    ...[false, true].map((en) => {
      const links = pages
        .filter((page) => page.url.startsWith("/en/") === en)
        .map(
          (page) => `- [${page.frontmatter.title}](${page.url}): ${page.frontmatter.description}`,
        );
      return `## ${en ? "English" : "简体中文"}\n\n${links.join("\n")}`;
    }),
  ].join("\n\n");

  const full = pages
    .map((page) => {
      const body = page.src?.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim() ?? "";
      return `URL: ${page.url}\n\n${body}`;
    })
    .join("\n\n---\n\n");

  await Promise.all([
    writeFile(join(config.outDir, "llms.txt"), `${index}\n`),
    writeFile(join(config.outDir, "llms-full.txt"), `${full}\n`),
  ]);
}

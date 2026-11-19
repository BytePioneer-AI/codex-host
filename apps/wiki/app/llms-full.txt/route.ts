import { source } from "@/lib/source";

export const dynamic = "force-static";

export async function GET() {
  const pages = await Promise.all(
    source.getPages().map(async (page) => {
      const markdown = await page.data.getText("processed");
      return `# ${page.data.title}\n\nURL: ${page.url}\n\n${markdown}`;
    }),
  );
  return new Response(pages.join("\n\n---\n\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

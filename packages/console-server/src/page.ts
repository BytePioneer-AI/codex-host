import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The console page is the renderer-extension console bundle; this server only
 * provides the document around it.
 */
export const CONSOLE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>codexhost console</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<script src="/app.js"></script>
</body>
</html>
`;

export const CONSOLE_PAGE_CSS = `:root { color-scheme: light dark; }
html, body { margin: 0; height: 100%; background: light-dark(#ffffff, #202020); }
`;

const MISSING_BUNDLE_SCRIPT = `document.body.textContent = "codexhost console assets are missing. Rebuild codexhost.";\n`;

/** Beside the entrypoint in a release; built by renderer-extension in a source checkout. */
export function consoleBundleCandidates(appDirectory: string): string[] {
  return [
    path.join(appDirectory, "console-web.js"),
    path.resolve(appDirectory, "..", "..", "renderer-extension", "dist", "console.js"),
  ];
}

export async function loadConsoleBundle(appDirectory: string): Promise<string> {
  for (const candidate of consoleBundleCandidates(appDirectory)) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      continue;
    }
  }
  return MISSING_BUNDLE_SCRIPT;
}

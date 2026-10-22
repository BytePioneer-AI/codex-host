import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

import { chromium } from "playwright";

import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

/** A one-page PDF whose only content is a text object. */
function samplePdf(): Buffer {
  const stream = "BT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

it(
  "opens chat file links in the right Sidebar with every shipped preview",
  { timeout: 90_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "codexhost-document-preview-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    writeFileSync(join(workspace, "notes.md"), "# Heading\n\nBody text\n");
    writeFileSync(join(workspace, "script.ts"), "export const answer = 42;\n");
    writeFileSync(
      join(workspace, "notes.txt"),
      Array.from({ length: 100 }, (_, index) => `plain line ${String(index + 1)}`).join("\n"),
    );
    writeFileSync(
      join(workspace, "photo.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    writeFileSync(
      join(workspace, "page.html"),
      "<!doctype html><title>t</title><p>html body</p>\n",
    );
    writeFileSync(join(workspace, "table.csv"), "name,value\none,1\ntwo,2\n");
    writeFileSync(join(workspace, "sample.pdf"), samplePdf());
    copyFileSync(
      join(import.meta.dirname, "../fixtures/office/sample.docx"),
      join(workspace, "sample.docx"),
    );
    copyFileSync(
      join(import.meta.dirname, "../fixtures/office/sample.pptx"),
      join(workspace, "sample.pptx"),
    );

    const host = new FakeChHost();
    const thread = host.add("local-thread", workspace, "Local Thread");
    const links = [
      "[notes.md](notes.md)",
      "[script.ts](script.ts)",
      "[notes.txt](notes.txt#L50)",
      "[photo.png](photo.png)",
      "[page.html](page.html)",
      "[table.csv](table.csv)",
      "[sample.pdf](sample.pdf)",
      "[sample.docx](sample.docx)",
      "[sample.pptx](sample.pptx)",
    ].join(" ");
    thread.turns = [
      {
        id: "turn",
        status: "completed",
        items: [
          { id: "u", type: "userMessage", content: [{ type: "text", text: "open these" }] },
          { id: "a", type: "agentMessage", text: links },
        ],
      },
    ];
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--adapters",
        "test/fake-harness",
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const target = new URL(url);
    target.searchParams.set("session", "local-thread");
    await page.goto(target.href);
    await page.getByText("open these", { exact: true }).waitFor();

    /**
     * Open one linked file and wait for its preview marker.
     * @param label - link text in the chat message.
     * @param marker - preview's DOM marker.
     */
    const open = async (label: string, marker: string): Promise<void> => {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.locator(marker).last().waitFor({ timeout: 30_000 });
      await page.locator("[data-sidebar-right-panel]").waitFor();
    };

    await open("notes.md", "[data-document-markdown]");
    assert.match(await page.locator("[data-document-markdown]").innerText(), /Heading/u);

    await open("script.ts", "[data-code-preview]");
    assert.match(await page.locator("[data-code-preview]").innerText(), /answer/u);

    await open("notes.txt", "[data-textpreview-plain]");
    const lines = page.locator("[data-textpreview-line]");
    assert.equal(await lines.count(), 100);
    await page.locator('[data-textpreview-target="50"]').waitFor();

    await open("photo.png", "[data-image-preview] img");

    await open("page.html", "[data-html-preview]");

    await open("table.csv", "[data-excel-preview]");
    await page.locator("[data-excel-preview] canvas").first().waitFor({ timeout: 30_000 });

    await open("sample.pdf", "[data-pdf-preview] [data-pdf-page]");

    await open("sample.docx", "[data-pdf-preview] [data-pdf-page]");
    await open("sample.pptx", "[data-pdf-preview] [data-pdf-page]");

    assert.deepEqual(errors, []);
  },
);

import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { convertXlsx } from "../../../apps/web-ui/packages/client/ui-sidebar-documentpreview/src/client/excel/xlsx.ts";

const require = createRequire(import.meta.url);
const browserExcel: typeof ExcelJS = require("exceljs/dist/exceljs.js");
const extendedProperties =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
let source: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.company = "Preview fixture";
  workbook.manager = "Test manager";
  workbook.addWorksheet("Sheet1").getCell("A1").value = "Example cell";
  source = new Uint8Array(await workbook.xlsx.writeBuffer());
});

/** XML namespace prefixes are arbitrary; preserve their URI and all workbook content. */
function withAppPrefix(prefix: string): Uint8Array<ArrayBuffer> {
  const files = unzipSync(source);
  const app = files["docProps/app.xml"];
  if (app === undefined) throw new Error("Fixture has no extended properties");
  const xml = strFromU8(app);
  files["docProps/app.xml"] = strToU8(
    prefix === ""
      ? xml
      : xml
          .replace(`xmlns="${extendedProperties}"`, `xmlns:${prefix}="${extendedProperties}"`)
          .replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, `<$1${prefix}:$2`),
  );
  return new Uint8Array(zipSync(files));
}

describe("spreadsheet extended-property namespaces", () => {
  it.each(["", "ap", "metadata"])("previews XLSX with app prefix %j", async (prefix) => {
    const bytes = withAppPrefix(prefix);
    const original = bytes.slice();
    const preview = await convertXlsx(bytes, {
      maxBytes: 1_000_000,
      maxCells: 10_000,
      timeoutMs: 10_000,
    });
    expect(preview.sheets).toHaveLength(1);
    expect(preview.sheets[0]?.celldata?.[0]?.v?.v).toBe("Example cell");
    expect(bytes).toEqual(original);
  });

  describe.each([
    ["Node", ExcelJS],
    ["browser", browserExcel],
  ] as const)("%s ExcelJS entry", (_name, library) => {
    it.each(["", "ap", "metadata"])("reads extended properties with prefix %j", async (prefix) => {
      const workbook = new library.Workbook();
      await workbook.xlsx.load(withAppPrefix(prefix).buffer);
      expect(workbook.company).toBe("Preview fixture");
      expect(workbook.manager).toBe("Test manager");
      expect(workbook.worksheets[0]?.getCell("A1").value).toBe("Example cell");
    });
  });
});

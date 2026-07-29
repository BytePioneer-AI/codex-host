import { applyPatch } from "diff";
import { z } from "zod";

const structuredHunkSchema = z
  .object({
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(z.string()),
  })
  .strict();

function assertDisplayPath(displayPath) {
  if (
    typeof displayPath !== "string" ||
    displayPath.length === 0 ||
    displayPath.includes("\n") ||
    displayPath.includes("\r")
  ) {
    throw new Error("displayPath must be a non-empty single-line path label");
  }
  return displayPath.replaceAll("\\", "/");
}

function countHunkLines(lines, prefixes) {
  return lines.filter((line) => prefixes.includes(line[0])).length;
}

function validateHunk(input) {
  const hunk = structuredHunkSchema.parse(input);
  if (hunk.lines.some((line) => ![" ", "+", "-", "\\"].includes(line[0]))) {
    throw new Error("structured patch lines must include a Unified Patch prefix");
  }
  if (countHunkLines(hunk.lines, [" ", "-"]) !== hunk.oldLines) {
    throw new Error("structured patch oldLines does not match hunk lines");
  }
  if (countHunkLines(hunk.lines, [" ", "+"]) !== hunk.newLines) {
    throw new Error("structured patch newLines does not match hunk lines");
  }
  return hunk;
}

export function structuredPatchToUnifiedPatch(displayPath, structuredPatch) {
  const safePath = assertDisplayPath(displayPath);
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) {
    throw new Error("structuredPatch must contain at least one native hunk");
  }

  const body = structuredPatch.flatMap((input) => {
    const hunk = validateHunk(input);
    return [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines,
    ];
  });
  return [`--- a/${safePath}`, `+++ b/${safePath}`, ...body, ""].join("\n");
}

export function verifyStructuredPatch({ before, after, displayPath, structuredPatch }) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  const patch = structuredPatchToUnifiedPatch(displayPath, structuredPatch);
  return applyPatch(before, patch) === after;
}

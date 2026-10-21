import { describe, expect, it } from "vitest";
import { workbenchConfigSchema, workbenchEntrySchema } from "../src/workbench.js";

const entry = {
  id: "entry-1",
  category: "knowledge",
  name: " Reference ",
  icon: " 📚 ",
  url: "https://example.com/docs",
};

describe("workbench configuration", () => {
  it("normalizes labels and accepts neutral knowledge, project and chat links", () => {
    for (const category of ["knowledge", "projects", "chats"]) {
      expect(workbenchEntrySchema.parse({ ...entry, category })).toMatchObject({
        name: "Reference",
        icon: "📚",
      });
    }
    expect(workbenchEntrySchema.parse({ ...entry, url: "http://localhost:3000/docs" }).url).toBe(
      "http://localhost:3000/docs",
    );
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/test",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://user@example.com",
    "https://example.com\\@other.example",
    "https://example.com/\nscript",
    "//example.com",
    "https://",
  ])("rejects unsafe link %s", (url) => {
    expect(workbenchEntrySchema.safeParse({ ...entry, url }).success).toBe(false);
  });
  it("bounds configuration and rejects duplicate IDs, unknown fields and blank values", () => {
    for (const input of [
      { version: 2, entries: [] },
      { version: 1, entries: [entry, entry] },
      { version: 1, entries: [], extra: true },
      { version: 1, entries: Array.from({ length: 101 }, (_, i) => ({ ...entry, id: String(i) })) },
      { version: 1, entries: [{ ...entry, name: " " }] },
      { version: 1, entries: [{ ...entry, icon: "" }] },
      { version: 1, entries: [{ ...entry, category: "unknown" }] },
    ])
      expect(workbenchConfigSchema.safeParse(input).success).toBe(false);
  });
});

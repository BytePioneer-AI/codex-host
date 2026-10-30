import { describe, expect, it } from "vitest";

import { externalTurnInputText } from "../src/external-turn-input.js";

const path = "C:\\图片\\screen shot.png";
const inline = { type: "image", url: "data:image/png;base64,aGVsbG8=" };
const local = (value: string) => ({ type: "localImage", path: value });
const text = (value: string) => ({ type: "text", text: value });
function manifest(paths: string[]): string {
  return (
    "# Files mentioned by the user:\n" +
    paths.map((value) => `\n## image.png: ${value}\nImage attachment: true\n`).join("") +
    "\n## My request:\nCompare these images"
  );
}

describe("External Turn input normalization", () => {
  it("preserves text-only input and its ordering", () => {
    expect(externalTurnInputText([text("first"), text("/second")])).toBe("first\n/second");
  });

  it.each([path, "/tmp/screen shot.png", "\\\\server\\share\\截图.png"])(
    "represents an image-only submission using its explicit path: %s",
    (file) => {
      expect(externalTurnInputText([local(file)])).toContain(`: ${file}\nImage attachment: true`);
    },
  );

  it("does not rewrite or duplicate existing CRLF attachment context", () => {
    const context = manifest([path]).replaceAll("\n", "\r\n");
    expect(externalTurnInputText([text(context), local(path)])).toBe(context);
    expect(externalTurnInputText([text(context), inline])).toBe(context);
  });

  it("adds only missing explicit paths and keeps the original request", () => {
    const original = manifest([path]);
    const missing = "/tmp/second.png";
    const result = externalTurnInputText([
      text(original),
      local(path),
      local(missing),
      local(missing),
    ]);
    expect(result.endsWith(original)).toBe(true);
    expect(result.split(`: ${path}\n`)).toHaveLength(2);
    expect(result.split(`: ${missing}\n`)).toHaveLength(2);
  });

  it("keeps an image-only native manifest in attachment context when filling a missing path", () => {
    const original = manifest([path]).split("## My request:")[0] ?? "";
    const missing = "/tmp/second.png";
    const result = externalTurnInputText([text(original), local(path), local(missing)]);
    expect(result).not.toContain("## My request:");
    expect(result.endsWith(original)).toBe(true);
    // A later request using inline previews must still see both references in native context.
    expect(externalTurnInputText([text(result), inline, inline])).toBe(result);
  });

  it("requires complete native references for mixed local and inline images", () => {
    const context = manifest([path, "/tmp/inline.png"]);
    expect(externalTurnInputText([text(context), local(path), inline])).toBe(context);
    expect(() => externalTurnInputText([text(manifest([path])), local(path), inline])).toThrow(
      /complete Desktop attachment paths/,
    );
    expect(() =>
      externalTurnInputText([text(context), local("/tmp/unrepresented.png"), inline]),
    ).toThrow(/complete Desktop attachment paths/);
  });

  it("accepts surplus references while still rejecting incomplete mixed attachment context", () => {
    const context = manifest([path, "/tmp/old.png", "/tmp/inline.png"]);
    expect(externalTurnInputText([text(context), local(path), inline])).toBe(context);
    expect(() => externalTurnInputText([text(context), local("/tmp/missing.png"), inline])).toThrow(
      /complete Desktop attachment paths/,
    );
  });

  it("consumes duplicate native references one at a time for mixed preview types", () => {
    const context = manifest([path, path]);
    expect(externalTurnInputText([text(context), local(path), inline])).toBe(context);
    expect(() => externalTurnInputText([text(context), local(path), local(path), inline])).toThrow(
      /complete Desktop attachment paths/,
    );
  });

  it("does not treat arbitrary user text or a quoted manifest after My request as saved images", () => {
    for (const content of [path, `## My request:\n${manifest([path])}`]) {
      expect(() => externalTurnInputText([text(content), inline])).toThrow(
        /complete Desktop attachment paths/,
      );
    }
  });

  it("does not silently turn an attached Harness command into an ordinary prompt", () => {
    const context = manifest([path]).replace("Compare these images", "/compact");
    for (const input of [
      [text("/compact"), local(path)],
      [text(context), local(path)],
      [text(context.replaceAll("\n", "\r\n")), inline],
      [text(context)],
    ]) {
      expect(() => externalTurnInputText(input)).toThrow(
        /commands and image attachments separately/,
      );
    }
    expect(externalTurnInputText([text("/compact")])).toBe("/compact");
  });

  it.each(
    [
      [],
      [text(" ")],
      [local("relative.png")],
      [local("C:\\bad\nimage.png")],
      [local("/tmp/bad\u0000.png")],
      [text("hello"), { type: "toolResponse", text: "not a prompt" }],
      [text("hello"), inline],
      [{ type: "text", text: 123 }],
      [null],
    ].map((input) => ({ input })),
  )("rejects input that cannot be represented faithfully: $input", ({ input }) => {
    expect(() => externalTurnInputText(input)).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { projectGrokGeneratedImage } from "../src/grok-generated-image.js";

const saved = "/Users/karlchow/.grok/sessions/session-1/images/1.jpg";
const exists = (absolutePath: string) => absolutePath === saved;

describe("Grok generated image projection", () => {
  it("reads ImageGen rawOutput with an existing absolute path", () => {
    expect(
      projectGrokGeneratedImage(
        undefined,
        {
          type: "ImageGen",
          path: saved,
          filename: "1.jpg",
          session_folder: "images",
        },
        exists,
      ),
    ).toEqual({ savedPath: saved, revisedPrompt: "1.jpg" });
  });

  it("reads ImageEdit rawOutput the same way", () => {
    expect(
      projectGrokGeneratedImage(
        undefined,
        { type: "ImageEdit", path: saved, filename: "1.jpg" },
        exists,
      ),
    ).toEqual({ savedPath: saved, revisedPrompt: "1.jpg" });
  });

  it("reads ACP JSON text that uses session_folder images without a type field", () => {
    expect(
      projectGrokGeneratedImage(
        [
          {
            type: "content",
            content: {
              type: "text",
              text: JSON.stringify({
                path: saved,
                filename: "1.jpg",
                session_folder: "images",
                message: "Image generated",
              }),
            },
          },
        ],
        undefined,
        exists,
      ),
    ).toEqual({ savedPath: saved, revisedPrompt: "1.jpg" });
  });

  it("ignores missing files, relative paths, and unrelated JSON", () => {
    expect(
      projectGrokGeneratedImage(
        undefined,
        { type: "ImageGen", path: saved, filename: "1.jpg" },
        () => false,
      ),
    ).toBeNull();
    expect(
      projectGrokGeneratedImage(
        undefined,
        { type: "ImageGen", path: "images/1.jpg", filename: "1.jpg" },
        exists,
      ),
    ).toBeNull();
    expect(
      projectGrokGeneratedImage(undefined, { type: "ReadFile", path: saved }, exists),
    ).toBeNull();
    expect(
      projectGrokGeneratedImage([{ type: "diff", path: saved }], undefined, exists),
    ).toBeNull();
  });
});

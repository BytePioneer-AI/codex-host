import { expect, it } from "vitest";
import {
  freshImageUrl,
  nextImageLoad,
} from "@deepseek-ai/dsh-client-ui-primitives/src/markdown/image-load.ts";

it("adds a stable per-mount cache key without re-encoding the owner's query", () => {
  const url = "https://host/api/file?path=%2Ftmp%2Fa%20b.png&token=a%2Bb#preview";
  const load = nextImageLoad();
  expect(freshImageUrl(url, load)).toBe(
    `https://host/api/file?path=%2Ftmp%2Fa%20b.png&token=a%2Bb&load=${load}#preview`,
  );
  expect(freshImageUrl(url, load)).toBe(freshImageUrl(url, load));
  expect(freshImageUrl(url, nextImageLoad())).not.toBe(freshImageUrl(url, load));
  expect(freshImageUrl("https://host/image.png", load)).toBe(`https://host/image.png?load=${load}`);
  expect(freshImageUrl("dsh-app://app/api/file?path=x", load)).toBe(
    `dsh-app://app/api/file?path=x&load=${load}`,
  );
});

it.each(["data:image/png;base64,abc", "blob:https://host/id", "/relative.png"])(
  "leaves %s unchanged",
  (url) => {
    expect(freshImageUrl(url, nextImageLoad())).toBe(url);
  },
);

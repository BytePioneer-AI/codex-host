import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { harnessIconStyles } from "../src/harness-icon-styles.ts";

it("preserves the Desktop Pi vector and colored/bitmap presentation without importing plugins", () => {
  const pi = JSON.parse(
    readFileSync(new URL("../../adapters/pi/manifest.json", import.meta.url), "utf8"),
  );
  const claude = JSON.parse(
    readFileSync(new URL("../../adapters/claude-code/manifest.json", import.meta.url), "utf8"),
  );
  const bitmap = {
    id: "bitmap",
    iconStyle: { background: "#ffffff", borderRadius: 25, paddingRatio: 0.2 },
  };
  const styles = harnessIconStyles([pi, claude, bitmap, { id: "plain" }]);
  assert.deepEqual(styles.pi, pi.iconStyle);
  assert.equal(styles.pi?.vector?.color, "currentColor");
  assert.deepEqual(styles["claude-code"], claude.iconStyle);
  assert.deepEqual(styles.bitmap, bitmap.iconStyle);
  assert.equal(styles.plain, null);
});
it("does not pass arbitrary SVG, CSS URLs or scripts through presentation metadata", () => {
  assert.deepEqual(
    harnessIconStyles([
      {
        id: "svg",
        iconStyle: {
          vector: {
            viewBox: "0 0 24 24",
            color: "currentColor",
            paths: [{ d: "<script>alert(1)</script>" }],
          },
        },
      },
      { id: "css", iconStyle: { background: "url(https://invalid.example/icon)" } },
    ]),
    { svg: null, css: null },
  );
});

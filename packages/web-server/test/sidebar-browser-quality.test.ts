import assert from "node:assert/strict";
import { it } from "node:test";
import { SidebarBrowserQualitySelection } from "../src/sidebar-browser-quality.ts";

const ANIMATION = 758 * 1024;
const SCROLL = 217 * 1024;
const PIXELS = 780 * 1560;

function sample(quality: SidebarBrowserQualitySelection, at: number, changes = {}) {
  quality.picture({
    at,
    bytes: ANIMATION,
    pixels: PIXELS,
    changed: true,
    replacedPending: true,
    ...changes,
  });
  return quality.update(at, []);
}

it("requires sustained large changing PNGs and repeated pressure, not just traffic or a big picture", () => {
  for (const changes of [
    { bytes: SCROLL },
    { pixels: 2000 * 1500 },
    { changed: false },
    { replacedPending: false },
  ]) {
    const quality = new SidebarBrowserQualitySelection("png");
    for (let i = 0; i < 12; i++) assert.equal(sample(quality, i * 30, changes), "full");
  }
  const quality = new SidebarBrowserQualitySelection("png");
  for (const at of [0, 30, 60, 90, 260, 290, 320, 350]) assert.equal(sample(quality, at), "full");
  assert.equal(sample(quality, 380), "motion");
});

it("keeps JPEG across short gaps and restores full PNG after 400 ms without a changed picture", () => {
  const quality = new SidebarBrowserQualitySelection("png");
  for (let i = 0; i < 5; i++) sample(quality, i * 30);
  assert.equal(quality.update(300, []), "motion");
  assert.equal(sample(quality, 350, { bytes: 200 * 1024 }), "motion");
  assert.equal(sample(quality, 650, { changed: false }), "motion");
  assert.equal(quality.deadline, 750);
  quality.input(740);
  assert.equal(quality.update(750, [1]), "full");
  assert.equal(
    quality.update(751, [1]),
    "full",
    "finishes with full PNG despite a stale slow sample",
  );
  assert.equal(sample(quality, 780), "full", "builds new evidence before switching again");
});

it("keeps 1x for slow interactive viewers but evaluates motion against its own 2x byte cost", () => {
  const quality = new SidebarBrowserQualitySelection("png");
  quality.size(SCROLL);
  quality.input(20);
  assert.equal(quality.update(21, [undefined, SCROLL * 9]), "reduced");
  assert.equal(quality.update(22, [SCROLL * 11]), "reduced");
  assert.equal(quality.update(420, [SCROLL * 9]), "full");
  for (let i = 0; i < 5; i++) sample(quality, 450 + i * 30);
  quality.input(600);
  const jpeg = 200 * 1024;
  sample(quality, 600, { bytes: jpeg });
  assert.equal(quality.update(601, [jpeg * 15]), "motion");
  assert.equal(quality.update(602, [jpeg * 9]), "reduced");
});

import assert from "node:assert/strict";
import { it } from "node:test";
import {
  SIDEBAR_INTERACTION_IDLE_MS,
  SidebarBrowserDelivery,
  sidebarBrowserReduced,
} from "../src/sidebar-browser-delivery.ts";

it("reduces only for a slow visible viewer during input, with separate recovery thresholds", () => {
  const frameBytes = 160_000;
  const lastInput = 500;
  const now = lastInput + 100;
  const slow = frameBytes * 8;
  const near = frameBytes * 11;
  const fast = frameBytes * 13;
  const choose = (reduced: boolean, rates: (number | undefined)[], at = now) =>
    sidebarBrowserReduced(at, lastInput, reduced, frameBytes, rates);

  assert.equal(choose(false, [fast, slow]), true);
  assert.equal(choose(false, [fast, undefined]), false);
  assert.equal(choose(false, [slow], lastInput + SIDEBAR_INTERACTION_IDLE_MS), false);
  assert.equal(choose(true, [slow], lastInput + SIDEBAR_INTERACTION_IDLE_MS), false);
  assert.equal(choose(false, [near]), false);
  assert.equal(choose(true, [near]), true);
  assert.equal(choose(true, [fast]), false);
});

it("estimates pipelined delivery from acknowledged bytes, ignoring idle time", () => {
  const link = new SidebarBrowserDelivery();
  link.sent(100);
  link.sent(150);
  link.acknowledged(250, 160_000, true);
  link.acknowledged(300, 160_000, false);
  assert.equal(link.rate(300, 0), 1_600_000);
  link.sent(5000);
  assert.equal(link.rate(5100, 320_000), 1_600_000);
  assert.equal(link.rate(5400, 320_000), 800_000);
  link.acknowledged(5400, 320_000, false);
  assert.equal(link.rate(5400, 0), 1_400_000);
});

it("doesn't mistake sparse frames for a saturated link with room to pipeline", () => {
  const link = new SidebarBrowserDelivery();
  for (const sent of [100, 500, 900]) {
    link.sent(sent);
    link.acknowledged(sent + 150, 160_000, false, true);
  }
  assert.equal(sidebarBrowserReduced(1060, 1050, false, 160_000, [link.rate(1060, 0)]), false);
});

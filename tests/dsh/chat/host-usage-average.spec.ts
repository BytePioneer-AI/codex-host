// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HostUsageDock } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/HostUsageDock.tsx";
import { en, zh } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/locales.ts";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  useAnchoredPosition: () => ({ left: 0, top: 0 }),
  useDismissOnOutsidePointer: () => {},
}));
type Props = ComponentProps<typeof HostUsageDock>;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each([en, zh])("shows session average separately from current Turn TPS and TTFT", (locale) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  const props: Props = {
    useProjection: vi.fn().mockReturnValue({
      usage: {
        outputTokensPerSecond: 25.1,
        timeToFirstOutputMs: 18_900,
        sessionOutputTokensPerSecond: 40,
      },
    }),
    t: ((key: keyof typeof en) => locale[key]) as Props["t"],
  };
  act(() => root.render(createElement(HostUsageDock, props)));
  const trigger = container.querySelector<HTMLButtonElement>(
    "[data-composer-stat='codexhost-usage'] button",
  );
  if (!trigger) throw new Error("Missing usage trigger");
  act(() => trigger.click());
  const sections = [...document.querySelectorAll("section")];
  const session = sections.find(
    (node) => node.querySelector("h3")?.textContent === locale["usage.group.session"],
  );
  const turn = sections.find(
    (node) => node.querySelector("h3")?.textContent === locale["usage.group.turn"],
  );
  expect(session?.textContent).toContain(locale["usage.speed.average"]);
  expect(session?.textContent).toContain("40 tok/s");
  expect(session?.querySelector("p")).toBeNull();
  expect(turn?.textContent).toContain("25.1 tok/s");
  expect(turn?.textContent).toContain("18.9");
  expect(turn?.textContent).not.toContain(locale["usage.speed.average"]);
});

it.each([undefined, 0])("hides an absent average but preserves a measured zero (%s)", (average) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  const props: Props = {
    useProjection: vi.fn().mockReturnValue({
      usage: {
        outputTokensPerSecond: 25.1,
        ...(average === undefined ? {} : { sessionOutputTokensPerSecond: average }),
      },
    }),
    t: ((key: keyof typeof en) => en[key]) as Props["t"],
  };
  act(() => root.render(createElement(HostUsageDock, props)));
  const trigger = container.querySelector<HTMLButtonElement>(
    "[data-composer-stat='codexhost-usage'] button",
  );
  if (!trigger) throw new Error("Missing usage trigger");
  act(() => trigger.click());
  expect(document.body.textContent?.includes(en["usage.speed.average"])).toBe(
    average !== undefined,
  );
  if (average === 0) expect(document.body.textContent).toContain("0 tok/s");
});

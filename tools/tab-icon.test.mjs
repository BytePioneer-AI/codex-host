import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { createTabIconContribution } from "../apps/web-ui/packages/client/ui-codexhost/src/client/native-extensions/tab-icon.ts";

it("restores original favicon nodes and order across visibility, competing owners and unload", () => {
  const dom = new JSDOM(
    '<!doctype html><head><link rel="icon" href="one.ico"><link rel="shortcut icon" href="two.png"><meta name="theme-color" content="#fff"></head>',
  );
  const doc = dom.window.document;
  const original = doc.head.innerHTML;
  const nodes = [...doc.querySelectorAll("link")];
  let visibility = "visible";
  Object.defineProperty(doc, "visibilityState", { get: () => visibility });
  const first = createTabIconContribution(doc);
  const second = createTabIconContribution(doc);
  const firstIcon = "data:image/png;base64,AAAA";
  const secondIcon = "data:image/png;base64,BBBB";
  first.set(firstIcon);
  second.set(secondIcon);
  expect(doc.querySelector('link[rel="icon"]').href).toBe(secondIcon);
  visibility = "hidden";
  doc.dispatchEvent(new dom.window.Event("visibilitychange"));
  expect(doc.head.innerHTML).toBe(original);
  visibility = "visible";
  doc.dispatchEvent(new dom.window.Event("visibilitychange"));
  second.dispose();
  expect(doc.querySelector('link[rel="icon"]').href).toBe(firstIcon);
  expect(() => first.set("https://example.com/icon.png")).toThrow();
  first.set(null);
  expect(doc.head.innerHTML).toBe(original);
  first.set(firstIcon);
  expect(doc.querySelector('link[rel="icon"]').href).toBe(firstIcon);
  first.dispose();
  first.dispose();
  expect(doc.head.innerHTML).toBe(original);
  expect([...doc.querySelectorAll("link")]).toEqual(nodes);
  first.set(firstIcon);
  expect(doc.head.innerHTML).toBe(original);
  dom.window.close();
});

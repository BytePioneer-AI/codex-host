import { expect, it } from "vitest";
import { desktopProjectPathKey } from "../src/desktop-project-definitions.js";

it.each([
  ["/Workspace/App", "/workspace/app"],
  ["C:\\Work\\Project", "/mnt/c/work/project"],
  ["\\\\?\\C:\\Work\\Project", "/mnt/c/work/project"],
  ["\\\\wsl.localhost\\Ubuntu\\home\\Work", "/home/work"],
  ["\\\\wsl$\\Ubuntu", "/"],
  ["\\\\?\\UNC\\Server\\Share\\Work", "//server/share/work"],
  ["\\\\Other\\Share\\Work", "//other/share/work"],
])("matches the Desktop sidebar path %s", (path, key) => {
  expect(desktopProjectPathKey(path)).toBe(key);
});

import { expect, test } from "vitest";
import { automaticUpdateUnavailableReason } from "../src/support.js";

test("Windows npm and EXE have no blanket platform gate", () => {
  expect(automaticUpdateUnavailableReason("win32", "npm")).toBeNull();
  expect(automaticUpdateUnavailableReason("win32", "windows-installer")).toBeNull();
  expect(automaticUpdateUnavailableReason("win32", "macos-dmg")).toContain(
    "cannot update a macOS installation",
  );
});
test("existing non-Windows execution policy does not acquire Windows requirements", () => {
  expect(automaticUpdateUnavailableReason("darwin", "npm")).toBeNull();
  expect(automaticUpdateUnavailableReason("darwin", "macos-dmg")).toBeNull();
  expect(automaticUpdateUnavailableReason("linux", "npm")).toBeNull();
});

import { expect, test } from "vitest";
import { automaticUpdateUnavailableReason } from "../src/support.js";

test("Windows execution is unavailable for either channel, not advertised from asset presence", () => {
  expect(automaticUpdateUnavailableReason("win32", "npm")).toContain("original global prefix");
  expect(automaticUpdateUnavailableReason("win32", "windows-installer")).toContain(
    "original directory",
  );
  expect(automaticUpdateUnavailableReason("win32", "macos-dmg")).toContain(
    "cannot update a macOS installation",
  );
});
test("existing non-Windows execution policy does not acquire Windows requirements", () => {
  expect(automaticUpdateUnavailableReason("darwin", "npm")).toBeNull();
  expect(automaticUpdateUnavailableReason("darwin", "macos-dmg")).toBeNull();
  expect(automaticUpdateUnavailableReason("linux", "npm")).toBeNull();
});

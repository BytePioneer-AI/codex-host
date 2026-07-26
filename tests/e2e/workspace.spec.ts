import { expect, test } from "@playwright/test";

test("the standalone E2E project loads without external applications", () => {
  const testDirectory = test.info().project.testDir.replaceAll("\\", "/");

  expect(testDirectory).toMatch(/\/tests\/e2e$/u);
});

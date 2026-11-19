import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { defaultWebDataDirectory } from "../src/data-paths.ts";

it("defaults to the Web subdirectory of the Host data root", () => {
  assert.equal(defaultWebDataDirectory(), join(homedir(), ".codexhost", "web"));
  assert.equal(defaultWebDataDirectory("custom-host"), resolve("custom-host", "web"));
});

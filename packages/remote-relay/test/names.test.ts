import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { selfHostedNames } from "../src/names.js";
import { createRelay } from "../src/index.js";
import { headers } from "../src/protocol.js";
import { certPath, fakeAgent, keyPath } from "./helpers.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const data = mkdtempSync(join(tmpdir(), "relay-names-"));
  directories.push(data);
  const open = () => selfHostedNames(data, "example.com", "relay.example.com");
  return { data, open, check: open() };
}

it("reserves a custom name to its identity across reconnects and restarts", () => {
  const { data, open, check } = fixture();
  const request = { id: "a".repeat(26), ip: undefined, name: "My-Computer" };
  expect(check(request)).toEqual({ name: "my-computer" });
  expect(check(request)).toEqual({ name: "my-computer" });
  const restarted = open();
  expect(restarted(request)).toEqual({ name: "my-computer" });
  expect(restarted({ ...request, id: "b".repeat(26) })).toEqual({ reject: "name-taken" });
  if (process.platform !== "win32")
    expect(statSync(join(data, "names.json")).mode & 0o777).toBe(0o600);
});

it("registers the requested hostname and rejects another identity without replacing its owner", async () => {
  const { check } = fixture();
  const relay = createRelay({ domain: "example.com", cert: certPath, key: keyPath, check });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as { port: number }).port;
  const options = {
    port,
    controlHost: "relay.example.com",
    registrationHeaders: { [headers.name]: "mycomputer" },
  };
  try {
    const owner = await fakeAgent(options);
    expect(await owner.registered).toBe("mycomputer.example.com");
    const other = await fakeAgent(options);
    expect(await other.closed).toBe(4411);
    expect(owner.ws.readyState).toBe(1);
  } finally {
    await relay.close();
  }
});

it("keeps derived addresses available only to their signing identity", () => {
  const { check } = fixture();
  const id = "a".repeat(26);
  expect(check({ id: "b".repeat(26), ip: undefined, name: id })).toEqual({ reject: "name-taken" });
  expect(check({ id, ip: undefined })).toEqual({ name: id });
  expect(check({ id, ip: undefined, name: "" })).toEqual({ name: id });
});

it.each(["relay", "RELAY", "-name", "name-", "a.b", "a_b", "a".repeat(64)])(
  "rejects invalid or reserved name %j",
  (name) => {
    expect(fixture().check({ id: "a".repeat(26), ip: undefined, name })).toEqual({
      reject: "name-taken",
    });
  },
);

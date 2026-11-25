import { expect, it, vi } from "vitest";
import { readRendererConnectionGeneration } from "../src/renderer-connection-generation.js";

const hostId = "remote-control:synthetic";
function store(...values: unknown[]) {
  return { familyBindings: new Map(values.map((value) => [{}, new Map([[hostId, { value }]])])) };
}
function connection(state: unknown = "connected", revision: unknown = 1) {
  return {
    state$: { get: () => state },
    revision$: { get: () => revision },
    appServerVersion$: {},
  };
}

it("identifies the published connection without reading unrelated atoms", () => {
  const get = vi.fn(() => {
    throw new Error("unrelated query must not run");
  });
  const owner = connection();
  expect(readRendererConnectionGeneration(store({ get }, owner), hostId)).toEqual({
    owner,
    revision: 1,
  });
  expect(get).not.toHaveBeenCalled();
});

it("preserves layouts with no connection signal and scopes lookup to one Host", () => {
  expect(readRendererConnectionGeneration(null, hostId)).toBeUndefined();
  expect(readRendererConnectionGeneration(store(connection()), "another-host")).toBeUndefined();
});

it.each([connection("disconnected"), connection("connecting"), connection("connected", NaN)])(
  "rejects unavailable or invalid connection snapshots",
  (value) => expect(readRendererConnectionGeneration(store(value), hostId)).toBeNull(),
);

it("deduplicates identical owners but rejects ambiguous owners and failed reads", () => {
  const owner = connection();
  expect(readRendererConnectionGeneration(store(owner, owner), hostId)?.owner).toBe(owner);
  expect(readRendererConnectionGeneration(store(owner, connection()), hostId)).toBeNull();
  const broken = {
    ...owner,
    state$: {
      get() {
        throw new Error("retired");
      },
    },
  };
  expect(readRendererConnectionGeneration(store(broken), hostId)).toBeNull();
});

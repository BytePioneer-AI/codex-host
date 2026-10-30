import { expect, it, vi } from "vitest";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { remoteConnectionsRequestSchema } from "@codexhost/shared-contracts";

it("routes remote reads without a local session and never falls back", async () => {
  const remoteRead = vi.fn().mockRejectedValue(new Error("offline"));
  const registry = new DelegationControlRegistry({ remoteRead });
  const input = { threadId: "same-id", hostId: "remote-mac", view: "messages" as const };
  await expect(registry.read(input)).rejects.toThrow("offline");
  expect(remoteRead).toHaveBeenCalledExactlyOnceWith(input);
  await expect(new DelegationControlRegistry().read(input)).rejects.toMatchObject({
    code: "RUNTIME_UNREACHABLE",
  });
  registry.close();
});

it("rejects mutations, nested routing and unbounded pages", () => {
  const request = {
    action: "read-thread",
    hostId: "mac",
    input: { threadId: "t", view: "messages" },
  };
  expect(remoteConnectionsRequestSchema.safeParse(request).success).toBe(true);
  for (const input of [
    { ...request.input, method: "turn/start" },
    { ...request.input, limit: 101 },
    { ...request.input, hostId: "another" },
  ]) {
    expect(remoteConnectionsRequestSchema.safeParse({ ...request, input }).success).toBe(false);
  }
});

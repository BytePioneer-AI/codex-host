import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import type { RendererModelClient } from "../src/renderer-model-client.js";
import { restoreThreadReferenceCapability } from "../src/renderer-thread-reference-capability.js";

const input = { threadId: hostThreadIdSchema.parse("historical") };
function fixture(value?: boolean) {
  const values = new Map<string, boolean>();
  const key = "thread-reference-capability:historical";
  if (value !== undefined) values.set(key, value);
  const inspect = vi
    .fn()
    .mockResolvedValue({ owner: "codex", locked: true, supportsThreadReferences: true });
  const original = Object.freeze({ inspectThread: inspect }) as unknown as RendererModelClient;
  let current = true;
  const storage = {
    readValue: vi.fn((key: string) => values.get(key)),
    writeValue: vi.fn((key: string, value: boolean) => values.set(key, value)),
  };
  const client = restoreThreadReferenceCapability(original, { storage }, () => current);
  expect(original.inspectThread).toBe(inspect);
  expect(Object.isFrozen(original)).toBe(true);
  return {
    client,
    inspect,
    storage,
    retire: () => {
      current = false;
    },
    values,
    key,
  };
}
it("restores missing native metadata only after Host proof", async () => {
  const f = fixture();
  await f.client.inspectThread(input);
  expect(f.inspect).toHaveBeenCalledWith({ ...input, includeReferenceCapability: true });
  expect(f.storage.writeValue).toHaveBeenCalledWith(f.key, true);
});

it.each(["before", "after"])(
  "preserves inspection when storage reads fail %s the RPC",
  async (phase) => {
    const f = fixture();
    if (phase === "after") f.storage.readValue.mockReturnValueOnce(undefined);
    f.storage.readValue.mockImplementation(() => {
      throw new Error("Persistence unavailable");
    });
    await expect(f.client.inspectThread(input)).resolves.toMatchObject({
      owner: "codex",
      locked: true,
    });
    expect(f.inspect).toHaveBeenCalledWith(
      phase === "before" ? input : { ...input, includeReferenceCapability: true },
    );
    expect(f.storage.writeValue).not.toHaveBeenCalled();
  },
);
it.each([false, true])("preserves an explicit %s native flag", async (value) => {
  const f = fixture(value);
  await f.client.inspectThread(input);
  expect(f.inspect).toHaveBeenCalledWith(input);
  expect(f.storage.writeValue).not.toHaveBeenCalled();
});
it.each([
  { owner: "codex", locked: true },
  { owner: "external", locked: true },
])("does not enable unproven support", async (response) => {
  const f = fixture();
  f.inspect.mockResolvedValue(response);
  await f.client.inspectThread(input);
  await f.client.inspectThread(input);
  expect(f.inspect.mock.calls.filter(([p]) => p.includeReferenceCapability)).toHaveLength(1);
  expect(f.storage.writeValue).not.toHaveBeenCalled();
});
it("falls back once on old Hosts without breaking ownership", async () => {
  const f = fixture();
  f.inspect.mockRejectedValueOnce(new Error("Invalid Thread inspection params"));
  f.inspect.mockResolvedValue({ owner: "codex", locked: true });
  await f.client.inspectThread(input);
  await f.client.inspectThread(input);
  expect(f.inspect).toHaveBeenCalledTimes(3);
  expect(f.storage.writeValue).not.toHaveBeenCalled();
});
it.each(["retired", "explicit false"])("ignores late proof after %s", async (reason) => {
  const f = fixture();
  let finish: (result: unknown) => void = () => {};
  f.inspect.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.client.inspectThread(input);
  if (reason === "retired") f.retire();
  else f.values.set(f.key, false);
  finish({ owner: "codex", locked: true, supportsThreadReferences: true });
  await pending;
  expect(f.storage.writeValue).not.toHaveBeenCalled();
});

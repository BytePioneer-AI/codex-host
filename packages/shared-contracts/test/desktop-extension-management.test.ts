import { expect, it } from "vitest";
import { CLIENT_CHANNEL_METHODS } from "../src/client-channel.js";
import { CONSOLE_HOST_METHODS } from "../src/console.js";
import {
  DESKTOP_EXTENSION_MANAGEMENT_METHODS,
  desktopExtensionMutationResultSchema,
  desktopExtensionSelectionParamsSchema,
  desktopExtensionsListParamsSchema,
  desktopExtensionsRecoveryParamsSchema,
} from "../src/desktop-extension-management.js";

it("allows only the four named Desktop extension operations on the client channel", () => {
  for (const method of DESKTOP_EXTENSION_MANAGEMENT_METHODS) {
    expect(CLIENT_CHANNEL_METHODS).toContain(method);
    expect(CONSOLE_HOST_METHODS).not.toContain(method);
  }
  expect(
    CLIENT_CHANNEL_METHODS.filter((method) => method.startsWith("codexhost/desktop/extensions/")),
  ).toEqual([...DESKTOP_EXTENSION_MANAGEMENT_METHODS]);
});

it("does not accept arbitrary paths, targets or code as management parameters", () => {
  expect(desktopExtensionsListParamsSchema.safeParse({ hostId: "remote" }).success).toBe(false);
  expect(desktopExtensionsRecoveryParamsSchema.safeParse({ directory: "/somewhere" }).success).toBe(
    false,
  );
  expect(desktopExtensionsRecoveryParamsSchema.safeParse({}).success).toBe(true);
  expect(
    desktopExtensionSelectionParamsSchema.safeParse({ id: "foo.bar_v1", expectedRevision: 0 })
      .success,
  ).toBe(true);
  expect(
    desktopExtensionSelectionParamsSchema.safeParse({
      id: "foo",
      expectedRevision: 0,
      script: "code",
    }).success,
  ).toBe(false);
  expect(
    desktopExtensionSelectionParamsSchema.safeParse({ id: "../foo", expectedRevision: 0 }).success,
  ).toBe(false);
  expect(
    desktopExtensionSelectionParamsSchema.safeParse({ id: "foo", expectedRevision: -1 }).success,
  ).toBe(false);
});

it("returns a typed slot owner and revision conflicts without a configuration write", () => {
  expect(
    desktopExtensionMutationResultSchema.parse({
      state: "slot-conflict",
      conflictWith: "example.tree",
    }),
  ).toEqual({ state: "slot-conflict", conflictWith: "example.tree" });
  expect(
    desktopExtensionMutationResultSchema.parse({ state: "revision-conflict", revision: 3 }),
  ).toEqual({ state: "revision-conflict", revision: 3 });
  expect(desktopExtensionMutationResultSchema.safeParse({ state: "slot-conflict" }).success).toBe(
    false,
  );
});

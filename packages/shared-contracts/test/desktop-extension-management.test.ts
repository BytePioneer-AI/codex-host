import { expect, it } from "vitest";
import { CLIENT_CHANNEL_METHODS } from "../src/client-channel.js";
import { CONSOLE_HOST_METHODS } from "../src/console.js";
import {
  DESKTOP_EXTENSION_MANAGEMENT_METHODS,
  desktopExtensionMutationResultSchema,
  desktopExtensionSelectionParamsSchema,
  desktopExtensionsInstallParamsSchema,
  desktopExtensionsListParamsSchema,
  desktopExtensionsUninstallParamsSchema,
  desktopExtensionsRecoveryParamsSchema,
} from "../src/desktop-extension-management.js";

it("allows only the named Desktop extension operations on the client channel", () => {
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

it("restricts install sources to catalog IDs, HTTP(S) URLs, or bounded base64", () => {
  const parse = (source: unknown) =>
    desktopExtensionsInstallParamsSchema.safeParse({ source }).success;
  expect(parse({ type: "catalog", id: "sample" })).toBe(true);
  expect(
    parse({ type: "url", url: "https://example.com/sample.zip", expectedSha256: "a".repeat(64) }),
  ).toBe(true);
  expect(parse({ type: "url", url: "file:///tmp/sample.zip" })).toBe(false);
  expect(parse({ type: "url", url: "http://user:secret@example.com/sample.zip" })).toBe(false);
  expect(
    parse({ type: "url", url: "https://example.com/sample.zip", expectedSha256: "A".repeat(64) }),
  ).toBe(false);
  expect(parse({ type: "zip-base64", fileName: "sample.zip", contentBase64: "UEs=" })).toBe(true);
  expect(parse({ type: "zip-base64", fileName: "sample.zip", contentBase64: "UE!=" })).toBe(false);
  expect(parse({ type: "path", path: "/tmp/sample.zip" })).toBe(false);
  expect(desktopExtensionsUninstallParamsSchema.safeParse({ id: "../sample" }).success).toBe(false);
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

import { describe, expect, it } from "vitest";

import { isNativePermissionModeControlCandidate } from "../src/renderer-composer-dom.js";

function nativePermissionButton(
  options: {
    target?: string;
    includeOwner?: boolean;
    codexhost?: boolean;
    hasMenu?: boolean;
  } = {},
): Element {
  const target = options.target ?? "permissions";
  const attributes = new Map<string, string>([
    ["data-composer-navigation-target", target],
    ["aria-haspopup", options.hasMenu === false ? "dialog" : "menu"],
  ]);
  if (options.codexhost) attributes.set("data-codexhost-permission-mode-control", "composer-1");
  const owner =
    options.includeOwner === false
      ? null
      : {
          memoizedProps: {
            showPermissionsModeDropdown: true,
            permissionsHostId: "local",
            permissionsCwdOverride: null,
          },
          return: null,
        };
  const fiber = {
    memoizedProps: {
      "data-composer-navigation-target": target,
      "aria-haspopup": options.hasMenu === false ? "dialog" : "menu",
    },
    return: owner,
  };
  const element = {
    hasAttribute(name: string) {
      return attributes.has(name);
    },
    matches(selector: string) {
      return (
        selector.includes('button[aria-haspopup="menu"]') &&
        attributes.get("aria-haspopup") === "menu" &&
        attributes.get("data-composer-navigation-target") === "permissions"
      );
    },
  };
  Object.defineProperty(element, "__reactFiber$test", { value: fiber });
  return element as unknown as Element;
}

describe("versioned native Permission Mode control ownership", () => {
  it("accepts the reviewed semantic trigger and Composer ownership chain", () => {
    expect(isNativePermissionModeControlCandidate(nativePermissionButton())).toBe(true);
  });

  it("does not identify by visible label or a partial DOM match", () => {
    expect(
      isNativePermissionModeControlCandidate(nativePermissionButton({ includeOwner: false })),
    ).toBe(false);
    expect(
      isNativePermissionModeControlCandidate(nativePermissionButton({ target: "model" })),
    ).toBe(false);
    expect(isNativePermissionModeControlCandidate(nativePermissionButton({ hasMenu: false }))).toBe(
      false,
    );
  });

  it("never recaptures the codexhost replacement control", () => {
    expect(
      isNativePermissionModeControlCandidate(nativePermissionButton({ codexhost: true })),
    ).toBe(false);
  });
});

// Adapted from karlorz/codex-host@07d8f010ae2e969007c611e035e49f3310b73a9d,
// packages/renderer-extension/src/renderer-composer-request.ts (LGPL-3.0-only).
/** Native question/approval inputs and actions are not chat submission controls. */
export const NATIVE_COMPOSER_REQUEST_ATTRIBUTES = [
  "data-codex-composer-request-navigation",
  "data-codex-composer-request",
] as const;
const NATIVE_REQUEST_SELECTOR = NATIVE_COMPOSER_REQUEST_ATTRIBUTES.map(
  (attribute) => `[${attribute}]`,
).join(", ");

export function isNativeComposerRequest(element: Element): boolean {
  return element.closest(NATIVE_REQUEST_SELECTOR) !== null;
}

/** Suspend chat controls for the whole root until the native request surface closes. */
export function hasNativeComposerRequest(composer: Element): boolean {
  return (
    isNativeComposerRequest(composer) || composer.querySelector(NATIVE_REQUEST_SELECTOR) !== null
  );
}

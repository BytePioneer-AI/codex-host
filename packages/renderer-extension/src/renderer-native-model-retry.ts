import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function containsMessage(children: unknown, id: string): boolean {
  const pending = [children];
  for (let remaining = 16; remaining > 0 && pending.length > 0; remaining -= 1) {
    const child = pending.pop();
    if (Array.isArray(child) && child.length <= 8) {
      for (const item of child) pending.push(item);
      continue;
    }
    const props = record(record(child)?.props);
    if (props?.id === id) return true;
    if (props?.children !== undefined) pending.push(props.children);
  }
  return false;
}

/** 26.1117 renders a button action (not a menu) under the native Model error tooltip. */
export function isNativeModelRetryButton(button: Element, composer: Element): boolean {
  if (
    button.getAttribute("data-composer-navigation-target") !== "reasoning" ||
    button.hasAttribute("aria-haspopup") ||
    button.getAttribute("aria-busy") === "true"
  )
    return false;
  const keys = Object.getOwnPropertyNames(button);
  const fiberKey = keys.find((key) => key.startsWith("__reactFiber$"));
  const propsKey = keys.find((key) => key.startsWith("__reactProps$"));
  if (!fiberKey || !propsKey) return false;
  const ancestors = committedReactAncestors(
    Object.getOwnPropertyDescriptor(button, fiberKey)?.value,
  );
  const host = ancestors[0];
  const props = record(host?.memoizedProps);
  const current = record(Object.getOwnPropertyDescriptor(button, propsKey)?.value);
  if (
    host?.stateNode !== button ||
    props?.["data-composer-navigation-target"] !== "reasoning" ||
    typeof props.onClick !== "function" ||
    props.onClick !== current?.onClick ||
    !containsMessage(props.children, "composer.modelPicker.retryModels")
  )
    return false;
  // Message IDs identify the error branch independently of locale or styling.
  for (const owner of ancestors.slice(1, 60)) {
    if (owner.stateNode === composer) break;
    const tooltip = record(owner.memoizedProps)?.content;
    if (record(record(tooltip)?.props)?.id === "composer.modelPicker.modelsUnavailable")
      return true;
  }
  return false;
}

/** Content-sized model collapse and opt-in phone action overflow. */
export interface ControlRowLayout {
  readonly phone: boolean;
  readonly overflowActions: boolean;
}

/** Observe live controls, never a cloned or second business component tree. */
export function observeControlRow(
  row: HTMLElement,
  onLayout?: (layout: ControlRowLayout) => void,
): () => void {
  const scrollport = row.querySelector<HTMLElement>("[data-toolbar-scroll]");
  if (scrollport === null) return () => {};
  const start = row.querySelector<HTMLElement>('[data-toolbar-fixed="start"]');
  const end = row.querySelector<HTMLElement>('[data-toolbar-fixed="end"]');
  let last: ControlRowLayout = { phone: false, overflowActions: false };
  let disposed = false;
  const observed = new Set<Element>();

  const revealFocus = (): void => {
    if (!last.phone || row.hasAttribute("data-toolbar-activity")) return;
    const active = row.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !row.contains(active)) return;
    if (active.closest("[data-toolbar-fixed]")) return;
    const { left, right } = scrollport.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    // Move only this scrollport, never the conversation or the draft selection.
    if (rect.left < left) scrollport.scrollLeft += rect.left - left;
    else if (rect.right > right)
      scrollport.scrollLeft += Math.min(rect.right - right, rect.left - left);
  };

  const measure = (): void => {
    if (disposed) return;
    const phone = row.closest("[data-phone]") !== null;
    row.toggleAttribute("data-phone-toolbar", phone);
    if (row.hasAttribute("data-toolbar-activity")) {
      if (phone !== last.phone) {
        last = { ...last, phone };
        onLayout?.(last);
      }
      return;
    }
    const wasOverflow = row.hasAttribute("data-actions-overflow");
    // Both rulers include the resident action even when its entry is in the
    // menu. The phone ruler includes the bounded model name, never icon-only.
    // Synchronous style reads finish before paint; no lifecycle changes.
    row.removeAttribute("data-model-compact");
    row.removeAttribute("data-actions-overflow");
    row.toggleAttribute("data-toolbar-measuring", phone);
    if (phone) {
      // Intrinsic fixed-seat widths do not depend on the middle viewport. In
      // particular, reserve both Stop and Send when a continuable child runs.
      // Guard writes so the style observer converges without re-notifying itself.
      for (const [name, seat] of [
        ["start", start],
        ["end", end],
      ] as const) {
        if (seat === null) continue;
        const property = `--dsh-composer-${name}-width`;
        const value = `${seat.getBoundingClientRect().width}px`;
        if (row.style.getPropertyValue(property) !== value) row.style.setProperty(property, value);
      }
    }
    const style = getComputedStyle(row);
    const available =
      row.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    const demand = (): number => {
      const items = (parent: Element): Element[] =>
        Array.from(parent.children).flatMap((child) => {
          const display = getComputedStyle(child).display;
          return display === "none"
            ? []
            : child === scrollport || display === "contents"
              ? items(child)
              : [child];
        });
      const controls = items(row);
      return (
        controls.reduce((sum, child) => {
          const childStyle = getComputedStyle(child);
          return (
            sum +
            child.getBoundingClientRect().width +
            (parseFloat(childStyle.marginLeft) || 0) +
            (parseFloat(childStyle.marginRight) || 0)
          );
        }, 0) +
        Math.max(0, controls.length - 1) * (parseFloat(style.columnGap) || 0)
      );
    };
    // Desktop retains its original two-group model-collapse/wrap behavior.
    const desktopDemand = (): number => {
      const widths = Array.from(
        scrollport.children,
        (child) => child.getBoundingClientRect().width,
      ).filter((width) => width > 0);
      return (
        widths.reduce((sum, width) => sum + width, 0) +
        Math.max(0, widths.length - 1) * parseFloat(style.columnGap)
      );
    };
    const expanded = phone ? demand() : desktopDemand();
    row.toggleAttribute("data-model-compact", !phone && expanded > available);
    const action = row.querySelector<HTMLElement>("[data-composer-overflow-action]");
    const menuTrigger = row.querySelector<HTMLButtonElement>('[data-toolbar-fixed="start"] button');
    // A read-only/preparing composer may lock + while an accessory stays live.
    // Keep that accessory in the scrollport rather than behind a disabled menu.
    const shouldOverflow =
      phone &&
      action !== null &&
      menuTrigger?.disabled === false &&
      expanded > available - (wasOverflow ? 2 : 0);
    // Keep the menu's candidate identity and a focused trigger stable until
    // that interaction ends. The middle viewport can scroll in either posture.
    const interacting =
      row.hasAttribute("data-command-menu-open") ||
      (action !== null && action.contains(row.ownerDocument.activeElement));
    const overflowActions = interacting ? wasOverflow : shouldOverflow;
    row.removeAttribute("data-toolbar-measuring");
    row.toggleAttribute("data-actions-overflow", overflowActions);
    if (phone !== last.phone || overflowActions !== last.overflowActions) {
      last = { phone, overflowActions };
      onLayout?.(last);
    }
    if (!phone || scrollport.scrollWidth <= scrollport.clientWidth) scrollport.scrollLeft = 0;
    revealFocus();
  };
  const resize = new ResizeObserver(measure);
  const watchControls = (): void => {
    const current = new Set<Element>([row, ...row.querySelectorAll("*")]);
    for (const node of observed) {
      if (!current.has(node)) {
        resize.unobserve(node);
        observed.delete(node);
      }
    }
    for (const node of current) {
      if (!observed.has(node)) {
        resize.observe(node);
        observed.add(node);
      }
    }
  };
  const mutation = new MutationObserver(() => {
    watchControls();
    measure();
  });
  mutation.observe(row, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "hidden",
      "class",
      "style",
      "aria-label",
      "aria-busy",
      "disabled",
      "data-command-menu-open",
      "data-toolbar-activity",
    ],
  });
  const posture = new MutationObserver(measure);
  for (let parent = row.parentElement; parent !== null; parent = parent.parentElement) {
    posture.observe(parent, {
      attributes: true,
      attributeFilter:
        parent === row.ownerDocument.body || parent === row.ownerDocument.documentElement
          ? ["data-phone", "class", "style", "lang", "dir"]
          : ["data-phone", "lang", "dir"],
    });
  }
  const afterFocus = (): void => {
    queueMicrotask(() => {
      if (!disposed) measure();
    });
  };
  row.addEventListener("focusin", revealFocus);
  row.addEventListener("focusout", afterFocus);
  const fonts = document.fonts;
  fonts.addEventListener("loadingdone", measure);
  watchControls();
  measure();
  return () => {
    disposed = true;
    resize.disconnect();
    mutation.disconnect();
    posture.disconnect();
    row.removeEventListener("focusin", revealFocus);
    row.removeEventListener("focusout", afterFocus);
    fonts.removeEventListener("loadingdone", measure);
  };
}

import type { Locator } from "playwright";

/** Open the typed menu at the start of the draft, preserving its content. */
export function composerMenu(composer: Locator, trigger: "/" | "@" = "/") {
  let openedText: string | undefined;
  return async () => {
    await composer.press("Escape");
    const text = await composer.innerText();
    await composer.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    if (text === openedText) await composer.press("Delete");
    await composer.pressSequentially(trigger);
    openedText = await composer.innerText();
  };
}

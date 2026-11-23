/** Menu reservations contributed by the product's shortcut reference integration. */
import type {
  ShortcutFixedCommand,
  ShortcutCommandId,
} from "@deepseek-ai/dsh-client-shortcuts/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";

/**
 * Describe shared menu actions for display and conflict checking.
 * @param t - shortcut dictionary.
 * @returns read-only actions and each physical combination they occupy.
 */
export function fixedCommands(
  t: PropsLocale<"shortcuts">["t"],
  windowsDesktop = false,
): readonly ShortcutFixedCommand[] {
  const rows = [
    {
      id: "move",
      keys: ["↑", "↓"],
      bindings: [
        { code: "ArrowUp", modifiers: [] },
        { code: "ArrowDown", modifiers: [] },
      ],
      group: "menus",
    },
    { id: "select", keys: ["Enter"], bindings: [{ code: "Enter", modifiers: [] }], group: "menus" },
    { id: "dismiss", keys: ["Esc"], bindings: [{ code: "Escape", modifiers: [] }], group: "menus" },
    ...(windowsDesktop
      ? ([
          {
            id: "zoom-in",
            keys: ["Ctrl", "+", "+"],
            bindings: [{ code: "Equal", modifiers: ["primary"] }],
            group: "application",
          },
          {
            id: "zoom-out",
            keys: ["Ctrl", "+", "−"],
            bindings: [{ code: "Minus", modifiers: ["primary"] }],
            group: "application",
          },
          {
            id: "zoom-reset",
            keys: ["Ctrl", "+", "0"],
            bindings: [{ code: "Digit0", modifiers: ["primary"] }],
            group: "application",
          },
        ] as const)
      : []),
  ] as const;
  return rows.map((row) => ({
    ...row,
    id: `fixed.${row.id}` as ShortcutCommandId,
    label: () => t(row.id),
  }));
}

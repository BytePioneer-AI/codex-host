/** macOS Finder-style restrained 7-color tag swatch picker for remote hosts. */
import type { ReactNode } from "react";
import clsx from "clsx";
import { REMOTE_PEER_COLORS, type RemotePeerColor } from "@codexhost/shared-contracts";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./RemotePeersPanel.module.css";

type Translate = PropsLocale<"codexhostImport">["t"];

export const PEER_COLOR_LABEL: Record<RemotePeerColor, Parameters<Translate>[0]> = {
  blue: "remotePeers.color.blue",
  purple: "remotePeers.color.purple",
  cyan: "remotePeers.color.cyan",
  green: "remotePeers.color.green",
  amber: "remotePeers.color.amber",
  rose: "remotePeers.color.rose",
  slate: "remotePeers.color.slate",
};

export function PeerColorPicker({
  value,
  onChange,
  disabled = false,
  size = "md",
  label,
  t,
}: {
  value: RemotePeerColor;
  onChange: (color: RemotePeerColor) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  label?: string;
  t: Translate;
}): ReactNode {
  return (
    <div
      className={clsx(css.colorPicker, size === "sm" && css.colorPickerSm)}
      role="radiogroup"
      aria-label={label ?? t("remotePeers.field.color")}
    >
      {REMOTE_PEER_COLORS.map((color) => {
        const selected = value === color;
        const name = t(PEER_COLOR_LABEL[color]);
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={name}
            title={name}
            disabled={disabled}
            className={clsx(css.colorSwatch, size === "sm" && css.colorSwatchSm)}
            data-color={color}
            data-selected={selected}
            onClick={() => onChange(color)}
          />
        );
      })}
    </div>
  );
}

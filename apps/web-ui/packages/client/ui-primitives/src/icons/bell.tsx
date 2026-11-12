/** Notification glyph in the shared regular-weight icon set. */
import type { IconProps } from "./props.ts";
import { ICON_REGULAR_STROKE } from "./index.tsx";

export function IconBellOutlineRegular({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_REGULAR_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.5 13a1.5 1.5 0 0 0 3 0M8 1.5v1M4 6.5a4 4 0 0 1 8 0c0 3 1.5 4 1.5 4.5h-11C2.5 10.5 4 9.5 4 6.5Z" />
    </svg>
  );
}

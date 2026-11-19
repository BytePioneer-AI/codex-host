import type { SidebarBrandMarkOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { useId } from "react";
import css from "./Brand.module.css";
import { OTTER_ACCENT_PATH, OTTER_BODY_PATH } from "./otter-paths";
import { WORDMARK_D_PATH, WORDMARK_E_PATH, WORDMARK_O_PATH } from "./wordmark-paths";

/**
 * Original option 05 otter rendered as resolution-independent vector paths.
 * Theme changes affect only the surrounding plate and inset, not the character's colors.
 * @param props - Host-supplied mark presentation.
 * @returns the CodexHost mark.
 */
export function CodexHostMark({
  size,
  className,
}: SidebarBrandMarkOwnerProps & { className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 384 384"
      className={className}
      role="img"
      aria-label="CodexHost"
      data-codexhost-mark="otter"
    >
      <circle className={css.darkPlate} cx="192" cy="192" r="190" fill="#f4f5f7" />
      <g className={css.otterArt} fillRule="evenodd">
        <path fill="#082e59" d={OTTER_BODY_PATH} />
        <path fill="var(--dsh-codexhost-mark-accent, #19a785)" d={OTTER_ACCENT_PATH} />
      </g>
    </svg>
  );
}

/**
 * Geometric codex wordmark and HOST badge, exposed as one accessible product name.
 * @returns the CodexHost sidebar wordmark.
 */
export function CodexHostName() {
  const cCutId = useId();
  return (
    <svg
      width={127}
      height={22}
      viewBox="0 0 102 17"
      className={css.wordmark}
      fill="currentColor"
      role="img"
      aria-label="CodexHost"
      data-codexhost-wordmark="codexhost"
    >
      <defs>
        <clipPath id={cCutId}>
          <path d="M-1 2 H12 V6.1 H7.5 V10.9 H12 V15 H-1 Z" />
        </clipPath>
      </defs>
      <g data-codexhost-word="codex">
        <g transform="translate(1 1)">
          <path clipPath={`url(#${cCutId})`} fillRule="evenodd" d={WORDMARK_O_PATH} />
        </g>
        <path transform="translate(13.013 1)" fillRule="evenodd" d={WORDMARK_O_PATH} />
        <g transform="translate(25.026 1)">
          <path transform="translate(-26.9563 -4.62817)" d={WORDMARK_D_PATH} />
        </g>
        <g transform="translate(37.031 1)">
          <path transform="translate(-38.9661 -4.62817)" d={WORDMARK_E_PATH} />
        </g>
        <path
          transform="translate(49.044 1)"
          d="M0 3.523 H2.963 L5.2 6.85 7.437 3.523 H10.4 L6.682 8.65 10.4 13.993 H7.437 L5.2 10.477 2.963 13.993 H0 L3.718 8.65 Z"
        />
      </g>
      <g className={css.hostBadge} data-codexhost-word="host">
        <rect x="68.35" y="1.872" width="33" height="14" rx="2" />
        <text className={css.hostBadgeText} x="84.85" y="12.422" textAnchor="middle">
          HOST
        </text>
      </g>
    </svg>
  );
}

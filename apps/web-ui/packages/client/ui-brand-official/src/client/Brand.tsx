import type { SidebarBrandMarkOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import css from "./Brand.module.css";
import { OTTER_ACCENT_PATH, OTTER_BODY_PATH } from "./otter-paths";

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
 * CodexHost wordmark shown beside the sidebar mark.
 * @returns the product name.
 */
export function CodexHostName() {
  return (
    <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
      CodexHost
    </span>
  );
}

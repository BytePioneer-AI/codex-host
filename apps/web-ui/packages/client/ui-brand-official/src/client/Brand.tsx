import type { SidebarBrandMarkOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";

/**
 * CodexHost mark: a rounded tile holding a prompt chevron and cursor.
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
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="CodexHost"
    >
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="currentColor" />
      <path
        d="M9.5 11.5 14 16l-4.5 4.5"
        stroke="var(--dsh-codexhost-mark-fg, var(--dsw-alias-bg-base, #fff))"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.5 21h6"
        stroke="var(--dsh-codexhost-mark-fg, var(--dsw-alias-bg-base, #fff))"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
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

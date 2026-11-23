/** Shared minimal monochrome line icons for remote host surfaces. */
import type { ReactNode } from "react";

export function RemoteHostIcon({
  size = 12,
  className,
}: {
  size?: number;
  className?: string;
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="8.5" rx="1.75" />
      <path d="M5.5 13.5h5M8 11v2.5" />
    </svg>
  );
}

export function HomeIcon(): ReactNode {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 7.25 8 2.5l5.5 4.75M4 6.25V13a.75.75 0 0 0 .75.75h2.25V10a1 1 0 0 1 1-1h0a1 1 0 0 1 1 1v3.75h2.25A.75.75 0 0 0 12 13V6.25"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function UnlockIcon(): ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="3.25"
        y="7.25"
        width="9.5"
        height="6.5"
        rx="1.75"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="M5.5 7.25V5.25a2.5 2.5 0 0 1 4.85-.85"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CheckMarkIcon({ className }: { className?: string }): ReactNode {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 5" />
    </svg>
  );
}

import type { IconProps } from "./props.ts";

/** Document with addition and removal marks for a file-change summary. */
export function IconFileDiffOutlineRegular({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M9 10h6m-3-3v6m-3 4h6" />
    </svg>
  );
}

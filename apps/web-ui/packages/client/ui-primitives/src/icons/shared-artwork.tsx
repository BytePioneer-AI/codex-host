import type { IconProps } from "./props.ts";

interface WeightedArtworkProps extends IconProps {
  strokeWidth: number;
}

/**
 * Render the compose glyph used by the native New Session control.
 * Keep the original 20px filled paths so every entry point uses the same geometry.
 * @param props - Size and optional CSS class; color follows the surrounding control.
 * @returns The decorative SVG artwork.
 */
export const NewChatOutlineArtwork = ({ size = 16, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 20 20"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path d="M8.16675 2.50127C8.53391 2.50127 8.83161 2.7992 8.83179 3.16631C8.83179 3.53358 8.53402 3.83135 8.16675 3.83135H5.83374C4.72836 3.83135 3.83197 4.72797 3.83179 5.8333V14.1663C3.83179 15.2718 4.72825 16.1683 5.83374 16.1683H14.1667C15.2722 16.1683 16.1687 15.2718 16.1687 14.1663V11.8333C16.1689 11.4662 16.4666 11.1683 16.8337 11.1683C17.2007 11.1684 17.4986 11.4663 17.4988 11.8333V14.1663C17.4988 16.0063 16.0068 17.4983 14.1667 17.4983H5.83374C3.99371 17.4983 2.50171 16.0063 2.50171 14.1663V5.8333C2.50189 3.99343 3.99382 2.50127 5.83374 2.50127H8.16675Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M13.4265 3.10381C14.3857 2.15908 15.9276 2.16466 16.8796 3.11651C17.8339 4.07106 17.8372 5.61827 16.8865 6.57647L11.7244 11.7786C11.3005 12.2058 10.7622 12.5027 10.1746 12.6321L7.78784 13.1565C7.20661 13.2842 6.6889 12.766 6.81714 12.1849L7.34253 9.80498C7.47294 9.21426 7.77197 8.67391 8.20288 8.24932L13.4265 3.10381ZM15.9392 4.05694C15.5038 3.62172 14.7988 3.61907 14.3601 4.05108L9.13647 9.19659C8.88861 9.44077 8.71644 9.75138 8.64136 10.0911L8.28979 11.6849L9.88843 11.3333C10.2265 11.2588 10.5362 11.0878 10.78 10.8421L15.9421 5.63897C16.3769 5.20075 16.3756 4.49352 15.9392 4.05694Z"
    />
  </svg>
);

/**
 * Render shared conversation geometry — the chat bubble around two text
 * lines — for the queue product icon and session reference icons.
 * @param props - Size, optional CSS class, and inherited stroke width.
 * @returns The decorative SVG artwork.
 */
export const ChatLinesOutlineArtwork = ({
  size = 16,
  className,
  strokeWidth,
}: WeightedArtworkProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    strokeWidth={strokeWidth}
  >
    <path d="M5 6.75H11" stroke="currentColor" />
    <path d="M5 9H8" stroke="currentColor" />
    <path
      d="M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334"
      stroke="currentColor"
    />
  </svg>
);

/**
 * Render shared globe geometry for product and link icons.
 * @param props - Size, optional CSS class, and inherited stroke width.
 * @returns The decorative SVG artwork.
 */
export const GlobeOutlineArtwork = ({
  size = 14,
  className,
  strokeWidth,
}: WeightedArtworkProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    strokeWidth={strokeWidth}
  >
    <path
      d="M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z"
      stroke="currentColor"
    />
    <path d="M2.34619 8H13.6538" stroke="currentColor" strokeLinecap="square" />
    <path
      d="M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138"
      stroke="currentColor"
    />
    <path
      d="M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138"
      stroke="currentColor"
    />
  </svg>
);

/**
 * Render shared code-bracket geometry for product and link icons.
 * @param props - Size, optional CSS class, and inherited stroke width.
 * @returns The decorative SVG artwork.
 */
export const CodeBracketsArtwork = ({
  size = 14,
  className,
  strokeWidth,
}: WeightedArtworkProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    strokeWidth={strokeWidth}
  >
    <path
      d="M4.67398 4.25061L1.36094 7.86484C1.29085 7.9413 1.29085 8.05866 1.36094 8.13513L4.67398 11.7494"
      stroke="currentColor"
    />
    <path
      d="M11.3262 4.25061L14.6392 7.86484C14.7093 7.9413 14.7093 8.05866 14.6392 8.13513L11.3262 11.7494"
      stroke="currentColor"
    />
    <path d="M9.56222 3.62573L6.43774 12.3743" stroke="currentColor" />
  </svg>
);

/**
 * Render shared document-browse geometry for product and reference icons.
 * @param props - Size, optional CSS class, and inherited stroke width.
 * @returns The decorative SVG artwork.
 */
export const BrowseOutlineArtwork = ({
  size = 16,
  className,
  strokeWidth,
}: WeightedArtworkProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    strokeWidth={strokeWidth}
  >
    <path d="M4.9375 5.90295H11.0625" stroke="currentColor" />
    <path d="M4.9375 9.02991H8.27841" stroke="currentColor" />
    <path
      d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z"
      fill="currentColor"
    />
  </svg>
);

/**
 * Render shared closed-folder geometry for product, reference, and link icons.
 * @param props - Size, optional CSS class, and inherited stroke width.
 * @returns The decorative SVG artwork.
 */
export const FolderCloseArtwork = ({ size = 16, className, strokeWidth }: WeightedArtworkProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    strokeWidth={strokeWidth}
  >
    <path
      d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z"
      stroke="currentColor"
    />
    <path d="M3.63501 7.66614H12.3647" stroke="currentColor" />
  </svg>
);

/** A QR code as inline SVG; the white plate stays white in dark themes so phones can read it. */
import { useMemo, type ReactNode } from "react";
import { encode } from "uqr";

/**
 * @param props.value - the text to encode.
 * @param props.label - the accessible name of the image.
 * @param props.className - sizes the image.
 * @returns the code, drawn as one path of dark modules with a quiet zone included.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}): ReactNode {
  const { size, path } = useMemo(() => {
    const code = encode(value, { ecc: "M", border: 2 });
    let modules = "";
    code.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) modules += `M${String(x)} ${String(y)}h1v1h-1z`;
      });
    });
    return { size: code.size, path: modules };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      className={className}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

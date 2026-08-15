declare module "*.png" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.svg" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.css" {
  const cssText: string;
  export default cssText;
}

declare module "lucide/dist/esm/createElement.mjs" {
  import type { IconNode, SVGProps } from "lucide";
  const createElement: (iconNode: IconNode, customAttributes?: SVGProps) => SVGElement;
  export default createElement;
}

declare module "lucide/dist/esm/icons/*.mjs" {
  import type { IconNode } from "lucide";
  const iconNode: IconNode;
  export default iconNode;
}

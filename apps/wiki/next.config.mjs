import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const root = fileURLToPath(new URL(".", import.meta.url));
const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default withMDX(config);

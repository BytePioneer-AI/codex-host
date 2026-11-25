import type { Plugin } from "esbuild";

export function compileSettingsTailwind(path: string): Promise<string>;
export function tailwindEsbuildPlugin(): Plugin;

import type { Context } from "./cordis.d.ts";
import type { DshPlugin } from "./plugin.d.ts";

export class LocalFileSystem {
  constructor(ctx: Context, config?: { cwd?: string });
}

declare const plugin: DshPlugin;
export default plugin;

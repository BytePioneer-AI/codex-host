import type { Context } from "./cordis.d.ts";

/** A Cordis plugin accepted by `Context.plugin`. */
export type DshPlugin = (ctx: Context, config?: unknown) => void | Promise<void>;

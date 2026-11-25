/** Native Loader surface used by the embedded Web plugin tree. */
import type { Context, Fiber } from "@deepseek-ai/cordis";
export interface EntryOptions {
  id: string;
  name: string;
  config?: any;
  group?: boolean | null;
  disabled?: boolean | null;
  inject?: unknown;
}
export interface Entry {
  id: string;
  options: EntryOptions;
  disabled: boolean;
  fiber?: Fiber;
  subtree?: EntryTree;
}
export abstract class EntryTree {
  constructor(ctx: Context);
  ctx: Context;
  store: Record<string, Entry>;
  root: { update(entries: EntryOptions[]): Promise<void>; stop(): void };
  create(options: Omit<EntryOptions, "id"> & { id?: string }): Promise<string>;
  remove(id: string): void;
  entries(): Iterable<Entry>;
  import(name: string, getOuterStack?: () => string[]): unknown;
  abstract write(): void;
}
export class Group {
  static readonly key: unique symbol;
}
export default class Loader extends EntryTree {
  constructor(ctx: Context, config?: { baseUrl?: string });
  builtins: Record<string, unknown>;
  await(): Promise<void>;
  write(): void;
}

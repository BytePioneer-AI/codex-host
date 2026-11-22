/** Include's native patch API and nested tree carrier. */
import { EntryTree, type EntryOptions } from "@deepseek-ai/cordis-plugin-loader";
import type { Schema } from "js-yaml";
export interface PatchOptions {
  id?: string;
  name?: string;
  insert?: EntryOptions[];
  [key: string]: unknown;
}
export const entryListSchema: Schema;
export function applyEntryPatches(
  data: EntryOptions[],
  patches: PatchOptions[],
  warn: (message: string, ...args: unknown[]) => void,
): EntryOptions[];
export default class Include extends EntryTree {
  write(): void;
}

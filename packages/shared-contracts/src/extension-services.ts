import { z } from "zod";
import { harnessPluginDescriptorSchema } from "./harness-plugins.js";

export const extensionHarnessPresentationSchema = harnessPluginDescriptorSchema.pick({
  id: true,
  name: true,
  icon: true,
  iconStyle: true,
});
export type ExtensionHarnessPresentation = z.infer<typeof extensionHarnessPresentationSchema>;

const extensionActivitySessionSchema = z.strictObject({
  threadId: z.string().max(1024),
  title: z.string().max(240),
  project: z.string().max(240),
  harness: z
    .strictObject({ id: z.string().min(1).max(128), name: z.string().min(1).max(128) })
    .optional(),
  state: z.enum(["idle", "running", "waiting", "completed", "failed"]),
  updatedAt: z.number().nonnegative(),
});

export const extensionActivitySchema = z.strictObject({
  epoch: z.string().max(128),
  revision: z.int().nonnegative(),
  running: z.int().nonnegative(),
  waiting: z.int().nonnegative(),
  sessions: z.array(extensionActivitySessionSchema).max(32).default([]),
  notifications: z
    .array(
      z.strictObject({
        threadId: z.string().max(1024),
        key: z.string().max(4096),
        kind: z.enum(["completed", "failed", "approval", "question"]),
        revision: z.int().nonnegative(),
      }),
    )
    .max(256),
});

export type ExtensionActivitySnapshot = z.infer<typeof extensionActivitySchema>;

export interface ExtensionWindowOptions {
  url: string;
  width: number;
  height: number;
}

export interface ExtensionBackendServices {
  activity: { read(): Promise<ExtensionActivitySnapshot> };
  harnesses: { describe(id: string): Promise<ExtensionHarnessPresentation | null> };
  windows: {
    /** True when the standalone CodexHost Desktop Shell executable is available on this Host. */
    readonly available: boolean;
    /** False when the Host display server cannot safely toggle transparent click-through (e.g. Linux Wayland). */
    readonly clickThroughSupported: boolean;
    open(options: ExtensionWindowOptions): Promise<void>;
    close(): Promise<void>;
    /** Show and navigate the standalone CodexHost Desktop Shell window (does not control Codex Desktop). */
    showHost(route?: string): Promise<void>;
  };
}

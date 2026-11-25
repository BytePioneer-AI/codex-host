/** Native metadata projected by the Web Host for this exact session. */
export interface NativePermissionMode {
  id: string;
  label: string;
  description?: string;
  dangerous?: boolean;
}

export interface NativePermissions {
  harnessId: string;
  catalog: { modes: NativePermissionMode[]; defaultModeId: string } | null;
  selectable: boolean;
  scope: "live" | "atCreate";
  locked: boolean;
}

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    /** No catalog means the Harness does not advertise selectable native permission modes. */
    nativePermissions: NativePermissions | null;
  }
}

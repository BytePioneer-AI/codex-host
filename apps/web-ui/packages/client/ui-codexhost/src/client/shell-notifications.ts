/** Native-shell notification bridge (Desktop shell and future mobile shells) and carrier detection. */

export type ShellNotificationPermission = "granted" | "denied" | "prompt" | "unsupported";

export interface ShellNotificationState {
  readonly enabled: boolean;
  readonly permission: ShellNotificationPermission;
}

export interface ShellNotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly tag?: string;
  readonly sessionId?: string;
  readonly kind: string;
}

export interface ShellNotificationClickPayload {
  readonly sessionId?: string;
}

export interface ShellNotificationBridge {
  getState(): Promise<ShellNotificationState>;
  requestPermission(): Promise<ShellNotificationPermission>;
  setEnabled(enabled: boolean): Promise<boolean>;
  send(payload: ShellNotificationPayload): Promise<boolean>;
  onClick(listener: (payload: ShellNotificationClickPayload) => void): () => void;
  openSystemSettings?: () => Promise<void>;
}

type NativeShellWindow = Window & {
  __codexhostNotifications?: Partial<ShellNotificationBridge>;
  __CODEXHOST_DESKTOP_SHELL__?: boolean;
  __CODEXHOST_NATIVE_SHELL__?: boolean;
  __codexhostAndroidHostSwitcher?: unknown;
};

export function getShellNotificationBridge(
  targetWindow: Window | undefined = typeof window === "undefined" ? undefined : window,
): ShellNotificationBridge | undefined {
  const candidate = (targetWindow as NativeShellWindow | undefined)?.__codexhostNotifications;
  if (
    candidate === undefined ||
    typeof candidate.getState !== "function" ||
    typeof candidate.requestPermission !== "function" ||
    typeof candidate.setEnabled !== "function" ||
    typeof candidate.send !== "function" ||
    typeof candidate.onClick !== "function"
  ) {
    return undefined;
  }
  return candidate as ShellNotificationBridge;
}

/** True when running inside any native CodexHost carrier (Desktop shell, Android shell, or future shells). */
export function isNativeShell(
  targetWindow: Window | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
  const candidate = targetWindow as NativeShellWindow | undefined;
  if (candidate === undefined) return false;
  return (
    candidate.__CODEXHOST_DESKTOP_SHELL__ === true ||
    candidate.__CODEXHOST_NATIVE_SHELL__ === true ||
    candidate.__codexhostAndroidHostSwitcher != null
  );
}

export interface HostRestartOptions {
  "restart-host"?: boolean;
  "keep-host"?: boolean;
}
export function hostRestartMode(options: HostRestartOptions): "restart" | "keep" | undefined;
export function readRunningHost(
  data: string,
  alive?: (pid: number) => unknown,
): Promise<{ runtime: string } | null>;
export function shouldRestartHost(options: {
  running: boolean;
  changed: boolean;
  mode?: "restart" | "keep" | undefined;
  otherInterfaceRunning: () => Promise<boolean>;
  otherInterface: string;
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<boolean>;

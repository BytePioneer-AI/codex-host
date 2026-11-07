export interface PreviewProcess {
  pid: number;
  created: string;
  command: string;
}
export const windowsDesktopDetectionScript: string;
export const macOsDesktopDetectionScript: string;
export function isDesktopRunning(
  platform?: NodeJS.Platform,
  run?: (command: string, args: string[]) => Promise<{ stdout: string }>,
): Promise<boolean>;
export function previewProcesses(): Promise<PreviewProcess[]>;
export function isAnyDevelopmentWeb(candidate: PreviewProcess): boolean;
export function isWebRunning(list?: typeof previewProcesses): Promise<boolean>;

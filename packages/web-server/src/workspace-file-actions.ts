/** Authenticated original-file downloads and local desktop handoff. */
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { RpcError } from "./transport.ts";

interface CabinetWindow {
  readonly hwnd: unknown;
  readonly addr: bigint;
  readonly title: string;
}

interface Win32ExplorerActivator {
  listCabinetWindows: () => CabinetWindow[];
  forceForeground: (hwnd: unknown) => void;
}

let cachedWin32Activator: Win32ExplorerActivator | null | undefined;

function getWin32ExplorerActivator(): Win32ExplorerActivator | null {
  if (cachedWin32Activator !== undefined) return cachedWin32Activator;
  try {
    const require = createRequire(import.meta.url);
    const koffi = require("koffi") as {
      load: (dll: string) => { func: (sig: string) => (...args: unknown[]) => unknown };
      address: (ptr: unknown) => bigint;
    };
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const findWindowExW = user32.func(
      "void* __stdcall FindWindowExW(void* parent, void* after, const char16* cls, const char16* title)",
    );
    const getWindowTextW = user32.func(
      "int __stdcall GetWindowTextW(void* hwnd, uint16* buf, int max)",
    );
    const getForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
    const getWindowThreadProcessId = user32.func(
      "uint32 __stdcall GetWindowThreadProcessId(void* hwnd, uint32* pid)",
    );
    const getCurrentThreadId = kernel32.func("uint32 __stdcall GetCurrentThreadId()");
    const attachThreadInput = user32.func(
      "bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)",
    );
    const isIconic = user32.func("bool __stdcall IsIconic(void* hwnd)");
    const showWindow = user32.func("bool __stdcall ShowWindow(void* hwnd, int nCmdShow)");
    const setForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(void* hwnd)");
    const bringWindowToTop = user32.func("bool __stdcall BringWindowToTop(void* hwnd)");
    const setWindowPos = user32.func(
      "bool __stdcall SetWindowPos(void* hwnd, intptr insertAfter, int X, int Y, int cx, int cy, uint32 uFlags)",
    );

    const titleBuf = Buffer.alloc(1024);
    const pidBuf = Buffer.alloc(4);
    const SW_SHOW = 5;
    const SW_RESTORE = 9;
    const HWND_TOPMOST = -1n;
    const HWND_NOTOPMOST = -2n;
    const SWP_FLAGS = 0x0001 | 0x0002 | 0x0040;

    cachedWin32Activator = {
      listCabinetWindows: () => {
        const windows: CabinetWindow[] = [];
        let hwnd: unknown = null;
        while ((hwnd = findWindowExW(null, hwnd, "CabinetWClass", null))) {
          const len = Number(getWindowTextW(hwnd, titleBuf, 512));
          const title = len > 0 ? titleBuf.subarray(0, len * 2).toString("utf16le") : "";
          windows.push({ hwnd, addr: koffi.address(hwnd), title });
        }
        return windows;
      },
      forceForeground: (hwnd: unknown) => {
        showWindow(hwnd, isIconic(hwnd) ? SW_RESTORE : SW_SHOW);
        const fg = getForegroundWindow();
        const fgTid = fg ? Number(getWindowThreadProcessId(fg, pidBuf)) : 0;
        const curTid = Number(getCurrentThreadId());
        const attached =
          fgTid !== 0 && fgTid !== curTid ? Boolean(attachThreadInput(curTid, fgTid, true)) : false;
        try {
          // Briefly toggling TOPMOST breaks Windows' background foreground lock without leaving the window pinned.
          setWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_FLAGS);
          setWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_FLAGS);
          setForegroundWindow(hwnd);
          bringWindowToTop(hwnd);
        } finally {
          if (attached) attachThreadInput(curTid, fgTid, false);
        }
      },
    };
  } catch {
    cachedWin32Activator = null;
  }
  return cachedWin32Activator;
}

async function bringExplorerWindowToFront(
  beforeAddrs: ReadonlySet<bigint>,
  folderPath: string,
): Promise<void> {
  const activator = getWin32ExplorerActivator();
  if (!activator) return;
  const folderName = (basename(folderPath) || folderPath).toLowerCase();
  for (let i = 0; i < 24; i++) {
    await new Promise((done) => setTimeout(done, 50));
    const current = activator.listCabinetWindows();
    const created = current.find((window) => !beforeAddrs.has(window.addr));
    if (created) {
      activator.forceForeground(created.hwnd);
      return;
    }
    if (i >= 4) {
      const matched = current.find((window) => {
        const title = window.title.toLowerCase();
        return (
          title === folderName ||
          title.startsWith(`${folderName} `) ||
          title.startsWith(`${folderName} -`) ||
          title.includes(folderName)
        );
      });
      if (matched) {
        activator.forceForeground(matched.hwnd);
        return;
      }
    }
  }
}

async function spawnDetachedFileManager(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, options);
    const onSpawn = () => {
      child.off("error", onError);
      child.unref();
      resolveSpawn();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      rejectSpawn(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

/** Reveal a workspace file or directory in the host OS file manager and bring it to the foreground. */
export async function revealWorkspaceFileFolder(path: unknown): Promise<{ opened: true }> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new RpcError("gateway/bad-request", "An absolute file path is required.");
  const target = await realpath(path);
  const info = await stat(target);
  if (!info.isFile() && !info.isDirectory())
    throw new RpcError("gateway/bad-request", "Only regular files or directories can be opened.");

  if (process.platform === "win32") {
    const folder = info.isFile() ? dirname(target) : target;
    const activator = getWin32ExplorerActivator();
    const beforeAddrs = new Set(
      activator ? activator.listCabinetWindows().map((window) => window.addr) : [],
    );
    const args = [info.isFile() ? `/select,"${target}"` : `"${target}"`];
    await spawnDetachedFileManager("explorer.exe", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    void bringExplorerWindowToFront(beforeAddrs, folder).catch(() => {});
  } else if (process.platform === "darwin") {
    const args = info.isFile() ? ["-R", target] : [target];
    await spawnDetachedFileManager("open", args, { detached: true, stdio: "ignore" });
  } else {
    await spawnDetachedFileManager("xdg-open", [info.isFile() ? dirname(target) : target], {
      detached: true,
      stdio: "ignore",
    });
  }
  return { opened: true };
}

export async function openWorkspaceFile(
  launcher: string,
  path: unknown,
): Promise<{ opened: true }> {
  if (!launcher || !isAbsolute(launcher))
    throw new RpcError("session/open-unavailable", "The native launcher is unavailable.");
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new RpcError("gateway/bad-request", "An absolute file path is required.");
  const target = await realpath(path);
  const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile())
      throw new RpcError("gateway/bad-request", "Only regular files can be opened.");
  } finally {
    await file.close();
  }
  await new Promise<void>((resolve, reject) => {
    execFile(launcher, ["open-file", target], { timeout: 10_000, windowsHide: true }, (error) => {
      if (error)
        reject(new RpcError("session/open-failed", "The system could not open this file."));
      else resolve();
    });
  });
  return { opened: true };
}

/** Download bytes without preview conversion or application-level size limits. */
export async function downloadWorkspaceFile(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  workspace: (sessionId: string) => string | undefined,
): Promise<void> {
  response.setHeader("Cache-Control", "private, no-store");
  const root = workspace(url.searchParams.get("sessionId") ?? "");
  const path = url.searchParams.get("path");
  if (!root || !path || path.includes("\0")) {
    response.writeHead(404).end();
    return;
  }
  let file;
  try {
    // Match workspace preview: absolute paths may name files outside the cwd.
    file = await open(resolve(root, path), constants.O_RDONLY | constants.O_NONBLOCK);
    const meta = await file.stat();
    if (!meta.isFile()) throw new Error("not a regular file");
    const name = basename(path);
    const encoded = encodeURIComponent(name).replace(
      /[!'()*]/gu,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`,
      "Content-Length": String(meta.size),
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD" || meta.size === 0) response.end();
    else
      await pipeline(
        file.createReadStream({ autoClose: false, end: Math.max(0, meta.size - 1) }),
        response,
      );
  } catch {
    if (!response.headersSent) response.writeHead(404).end();
    else response.destroy();
  } finally {
    await file?.close();
  }
}

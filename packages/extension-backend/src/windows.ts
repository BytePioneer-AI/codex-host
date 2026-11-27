import type { ExtensionBackendServices } from "@codexhost/shared-contracts";

export function createExtensionWindows(
  executable: string | undefined,
  dataDir: string,
  hostDataDir?: string,
): ExtensionBackendServices["windows"] {
  const { spawn } = process.getBuiltinModule("node:child_process");
  const { existsSync } = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  let child: ReturnType<typeof spawn> | undefined;
  let opening: Promise<void> | undefined;
  let cancelOpening: (() => void) | undefined;
  const available = Boolean(executable && path.isAbsolute(executable) && existsSync(executable));
  const environment = Object.fromEntries(
    [
      "SystemRoot",
      "PATH",
      "USERPROFILE",
      "HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME",
      "DBUS_SESSION_BUS_ADDRESS",
      "LANG",
      "LC_ALL",
    ].map((name) => [name, process.env[name]]),
  );
  const close = async () => {
    const current = child;
    child = undefined;
    cancelOpening?.();
    if (!current) return;
    current.stdin?.end();
    if (current.exitCode !== null || current.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        current.kill();
        resolve();
      }, 1_000);
      current.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  return {
    available,
    async open(options) {
      if (opening) return opening;
      if (child) return;
      if (!available || !executable) throw new Error("Native extension windows are unavailable");
      const url = new URL(options.url);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password
      )
        throw new Error("Extension windows require a loopback HTTP URL");
      for (const size of [options.width, options.height])
        if (!Number.isInteger(size) || size < 96 || size > 640)
          throw new Error("Invalid window size");
      const current = spawn(executable, ["--extension-window"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        env: environment,
      });
      child = current;
      current.once("exit", () => {
        if (child === current) child = undefined;
      });
      opening = new Promise<void>((resolve, reject) => {
        let settled = false;
        let output = "";
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancelOpening = undefined;
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => {
          finish(new Error("Native window startup timed out"));
          void close();
        }, 8_000);
        cancelOpening = () => finish(new Error("Native window startup cancelled"));
        current.once("error", (error) => {
          if (child === current) child = undefined;
          finish(error);
        });
        current.once("exit", () => finish(new Error("Native window exited")));
        current.stdout?.on("data", (bytes: Buffer) => {
          output = (output + bytes.toString("utf8")).slice(-1024);
          if (output.split(/\r?\n/u).includes("ready")) finish();
        });
        current.stdin?.on("error", () => undefined);
        current.stdin?.write(
          JSON.stringify({ ...options, positionPath: path.join(dataDir, "window-position.json") }) +
            "\n",
        );
      }).finally(() => {
        opening = undefined;
      });
      return opening;
    },
    close,
    async showHost(route = "/") {
      if (!available || !executable || !hostDataDir || !path.isAbsolute(hostDataDir))
        throw new Error("Host window navigation is unavailable");
      if (typeof route !== "string")
        throw new Error("Host navigation requires a root-relative route");
      const base = new URL("http://127.0.0.1/");
      const target = new URL(route, base);
      if (
        route.length > 2048 ||
        !/^\/(?:[?#]|$)/u.test(route) ||
        /[\\\p{Cc}\s]/u.test(route) ||
        target.origin !== base.origin ||
        target.pathname !== "/" ||
        target.searchParams.has("token")
      )
        throw new Error("Host navigation requires a root-relative route");
      await new Promise<void>((resolve, reject) => {
        const activation = spawn(executable, ["--data-dir", hostDataDir, "--route", route], {
          stdio: "ignore",
          windowsHide: true,
          env: environment,
          detached: process.platform !== "win32",
        });
        activation.once("error", reject);
        const timer = setTimeout(() => {
          activation.unref();
          resolve();
        }, 500);
        activation.once("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error("Host window could not be opened"));
        });
      });
    },
  };
}

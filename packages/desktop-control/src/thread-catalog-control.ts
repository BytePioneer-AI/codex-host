import { createConnection } from "node:net";

/** Best-effort catalog invalidation on an existing Desktop Controller. */
export async function requestDesktopThreadCatalogRefresh(
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const port = Number(environment.CODEXHOST_CONTROL_PORT);
  const nonce = environment.CODEXHOST_CONTROL_NONCE;
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !nonce ||
    !/^[0-9a-f]{32}$/u.test(nonce)
  )
    return;
  try {
    await new Promise<void>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (): void => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      };
      const timer = setTimeout(finish, 1_000);
      socket.once("error", finish);
      socket.once("end", finish);
      socket.once("close", finish);
      socket.once("data", finish);
      socket.once("connect", () => socket.write(`CATALOG ${nonce}\n`));
    });
  } catch {
    // This hint never blocks native Session creation or triggers Desktop startup.
  }
}

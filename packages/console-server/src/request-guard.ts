/**
 * The console has no login: it serves only this machine. These checks keep
 * other websites open in the user's browser from using it.
 */

/** Header the page sends with every change. Browsers cannot add it cross-origin without CORS. */
export const CONSOLE_REQUEST_HEADER = "x-codexhost-console";

/** Only the console's own loopback authorities are accepted (DNS-rebinding defense). */
export function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * A change must carry the console header, and a browser request must come
 * from the console page. Local tools without an Origin (the `open` command)
 * are allowed; they already run as the user.
 */
export function allowedChange(
  origin: string | undefined,
  consoleHeader: string | undefined,
  port: number,
): boolean {
  if (consoleHeader !== "1") return false;
  return (
    origin === undefined ||
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  );
}

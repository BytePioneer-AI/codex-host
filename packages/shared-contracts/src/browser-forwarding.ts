/**
 * Sidebar browser forwarding: a page served on the Web server machine's loopback is opened
 * through a Web-server listener so the viewer's own browser renders it.
 *
 * Kept free of runtime dependencies and exported as `@codexhost/shared-contracts/browser-forwarding`
 * so the sidebar browser bundle does not inline the full contract package.
 */
export const BROWSER_FORWARD_METHOD = "codexhost/browserForward";

export interface BrowserForwardParams {
  readonly url: string;
}

/** The listener port on the Web server host; the viewer combines it with the host it already uses. */
export interface BrowserForwardResult {
  readonly port: number;
}

/** @returns the params, or undefined when the request is malformed. */
export function parseBrowserForwardParams(value: unknown): BrowserForwardParams | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { url } = value as { url?: unknown };
  return typeof url === "string" && url !== "" ? { url } : undefined;
}

/** @throws {Error} when the result is not a TCP port. */
export function parseBrowserForwardResult(value: unknown): BrowserForwardResult {
  const port = (value as { port?: unknown } | null)?.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid browser forwarding result.");
  return { port };
}

/**
 * Whether a URL hostname names the machine that resolves it. In the viewer's browser such an
 * address means the viewer's machine, so the sidebar forwards it to the Web server machine.
 * @param hostname - `URL.hostname`, with IPv6 brackets.
 */
export function isLoopbackBrowserHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
  );
}

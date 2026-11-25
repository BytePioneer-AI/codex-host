import { readFile } from "node:fs/promises";
import path from "node:path";
import { processIsAlive } from "./diagnostics.js";

/** Only connection-page RPCs, never arbitrary Web requests. */
export const WEB_CONNECTION_METHODS = [
  "codexhost/accessTokenGet",
  "codexhost/accessTokenRegenerate",
  "codexhost/lanSet",
  "codexhost/autostartSet",
  "codexhost/tailscaleServeSet",
] as const;

/** Web owns the credentials and all configuration; Console only forwards local requests. */
export async function webConnectionRequest(
  dataDirectory: string,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!(WEB_CONNECTION_METHODS as readonly string[]).includes(method)) {
    throw new Error("Web method is not available");
  }
  let url: URL;
  let token: string;
  try {
    const ready = JSON.parse(
      await readFile(path.join(dataDirectory, "web-service-ready.json"), "utf8"),
    ) as { pid: number; web_pid: number; loginUrl: string };
    if (!processIsAlive(ready.pid) || !processIsAlive(ready.web_pid)) throw new Error();
    const login = new URL(ready.loginUrl);
    token = login.searchParams.get("token") ?? "";
    if (
      login.protocol !== "http:" ||
      login.hostname !== "127.0.0.1" ||
      login.username ||
      login.password ||
      login.pathname !== "/" ||
      !token
    )
      throw new Error();
    url = new URL(`/api/${method}`, login.origin);
  } catch {
    throw new Error("Web 未运行或尚未就绪，请先启动 Web。");
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: "client-request", rpcId: "console", method, payload: { args } }),
      signal: AbortSignal.timeout(15_000),
    });
    const reply = (await response.json()) as {
      result?: { ok: boolean; value?: unknown; error?: { message: string } };
    };
    if (!response.ok || !reply.result) throw new Error("Web 请求失败");
    if (!reply.result.ok) throw new Error(reply.result.error?.message ?? "Web 请求失败");
    return reply.result.value;
  } catch (error) {
    // fetch errors can contain the authenticated URL; do not expose transport diagnostics.
    if (error instanceof TypeError) throw new Error("Web 连接已断开，请稍后重试。");
    throw error;
  }
}

import { createConnection } from "node:net";
import {
  remoteConnectionsReplySchema,
  remoteConnectionsRequestSchema,
  type RemoteConnectionsReply,
  type RemoteConnectionsRequest,
} from "@codexhost/shared-contracts";

const MAX_REPLY_BYTES = 1024 * 1024;

/** Fixed renderer API; user input is data, never executable JavaScript. */
export function remoteConnectionsExpression(input: RemoteConnectionsRequest): string {
  const request = remoteConnectionsRequestSchema.parse(input);
  return `(async () => {
    try {
      const api = window.__codexhostRendererBindingProbeV1;
      if (!api?.remoteConnections) return {error:{code:-32090,message:"Remote connection management is unavailable. Restart Codex through codexhost"}};
      return {result:await api.remoteConnections(${JSON.stringify(request)})};
    } catch (error) {
      return {error:{code:typeof error?.code === "number" ? error.code : -32603,message:String(error?.message ?? error)}};
    }
  })()`;
}

/** The Host uses the Launcher's authenticated loopback Controller channel. */
export async function requestDesktopRemoteConnections(
  environment: NodeJS.ProcessEnv,
  input: unknown,
  timeoutMs = 30_000,
): Promise<RemoteConnectionsReply> {
  const request = remoteConnectionsRequestSchema.safeParse(input);
  if (!request.success)
    return { error: { code: -32602, message: "Invalid remote connection request" } };
  const port = Number(environment.CODEXHOST_CONTROL_PORT);
  const nonce = environment.CODEXHOST_CONTROL_NONCE;
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !nonce ||
    !/^[0-9a-f]{32}$/u.test(nonce)
  )
    return {
      error: {
        code: -32090,
        message: "Remote connection management is unavailable. Restart Codex through codexhost",
      },
    };
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let output = "";
    let settled = false;
    const finish = (reply: RemoteConnectionsReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const fail = (): void =>
      finish({
        error: {
          code: -32090,
          message: "Remote connection management is unavailable. Restart Codex through codexhost",
        },
      });
    const timer = setTimeout(
      () =>
        finish({
          error: {
            code: -32093,
            message: "Remote connection request timed out. Refresh before retrying",
          },
        }),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) fail();
    });
    socket.once("connect", () => socket.write(`REMOTE ${nonce} ${JSON.stringify(request.data)}\n`));
    socket.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_REPLY_BYTES) {
        fail();
        return;
      }
      const end = output.indexOf("\n");
      if (end < 0) return;
      try {
        finish(remoteConnectionsReplySchema.parse(JSON.parse(output.slice(0, end))));
      } catch {
        fail();
      }
    });
  });
}

import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { CodeBuddyError } from "./common.js";
import { codeBuddyAcpOutput } from "./acp-stdio.js";

/** The existing administrative ACP process also owns a short-lived native delete endpoint. */
export class CodeBuddyCopyCleanup {
  readonly password = randomBytes(32).toString("base64url");
  readonly arguments = [
    "--acp",
    "--serve",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--auth",
    "password",
  ];
  #endpoint: string | undefined;

  constructor(
    readonly copyId: string,
    readonly cwd: string,
  ) {}

  environment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...environment,
      CODEBUDDY_GATEWAY_AUTH: "password",
      CODEBUDDY_GATEWAY_PASSWORD: this.password,
      CODEBUDDY_GATEWAY_BASE_PATH: "",
    };
  }

  /** Native --serve banners include its password; never pass them to the ACP parser/logs. */
  protocolOutput(stdout: Readable): Readable {
    return codeBuddyAcpOutput(stdout, (line) => {
      const endpoint = /^\s*Endpoint\s+(http:\/\/127\.0\.0\.1:\d+)\s*$/u.exec(line);
      if (endpoint) this.#endpoint = endpoint[1];
    });
  }

  async remove(): Promise<void> {
    if (!this.#endpoint)
      throw new CodeBuddyError(
        "nativeFailure",
        `Native cleanup endpoint was not reported; temporary Session ${this.copyId} remains`,
      );
    const response = await fetch(
      `${this.#endpoint}/api/v1/sessions/${encodeURIComponent(this.copyId)}?cwd=${encodeURIComponent(this.cwd)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.password}`, "x-codebuddy-request": "true" },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    ).catch(() => {
      throw new CodeBuddyError(
        "nativeFailure",
        `Native cleanup request failed; temporary Session ${this.copyId} remains`,
      );
    });
    await response.body?.cancel();
    if (response.status !== 204)
      throw new CodeBuddyError(
        "nativeFailure",
        `Native cleanup failed (${response.status}); temporary Session ${this.copyId} remains`,
      );
  }
}

import { z } from "zod";

/** Opens the local codexhost console in the default browser. Local Host only. */
export const CONSOLE_OPEN_METHOD = "codexhost/console/open";

export const consoleOpenParamsSchema = z.strictObject({});

export const consoleOpenResultSchema = z.strictObject({
  /** The console address. */
  url: z
    .string()
    .max(2048)
    .regex(/^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/(?:\?.*)?$/u),
});

export type ConsoleOpenResult = z.infer<typeof consoleOpenResultSchema>;

/**
 * Host methods the local console may call through the Host Runtime's console
 * channel: the settings Codex exposes, never Thread or Turn operations.
 */
export const CONSOLE_HOST_METHODS = Object.freeze([
  "codexhost/harness/plugins/list",
  "codexhost/harness/inspect",
  "codexhost/harness/launch-settings/get",
  "codexhost/harness/launch-settings/set",
  "codexhost/harness/web-ui/open",
  "codexhost/harness/accounts/sources",
  "codexhost/harness/accounts/list",
  "codexhost/harness/accounts/inspect",
  "codexhost/harness/credential-imports",
  "codexhost/harness/session-import/sources",
  "codexhost/harness/session-import/list",
  "codexhost/harness/session-import/import",
  "codexhost/account/list",
  "codexhost/account/refresh",
  "codexhost/account/usage/inspect",
  "codexhost/update/check",
  "codexhost/update/start",
  "codexhost/update/status",
] as const);

export type ConsoleHostMethod = (typeof CONSOLE_HOST_METHODS)[number];

export function isConsoleHostMethod(method: string): method is ConsoleHostMethod {
  return (CONSOLE_HOST_METHODS as readonly string[]).includes(method);
}

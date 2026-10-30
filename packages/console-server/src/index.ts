export { allowedChange, allowedHost, CONSOLE_REQUEST_HEADER } from "./request-guard.js";
export {
  readControllerStatus,
  readStartupRecords,
  summarize,
  type ConsoleSummary,
} from "./diagnostics.js";
export { DEFAULT_CONSOLE_PORT, consolePaths, consolePort } from "./paths.js";
export { CONSOLE_SERVICE, startConsoleServer } from "./server.js";
export { createConsoleUpdates } from "./updates.js";

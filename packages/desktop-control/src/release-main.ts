import { readControllerLifecycle } from "./controller-lifecycle.js";
import { parseDesktopControllerArguments, runDesktopController } from "./production-controller.js";

const abort = new AbortController();
const stop = (): void => {
  if (abort.signal.aborted) return;
  // If Renderer or socket cleanup does not finish, only this Controller exits.
  setTimeout(() => process.exit(0), 4_000).unref();
  abort.abort();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const options = parseDesktopControllerArguments(process.argv.slice(2));
  const lifecycle = readControllerLifecycle(options.attachmentNonce, stop);
  await runDesktopController(options, abort.signal, undefined, lifecycle);
} catch (error) {
  console.error(
    `codexhost Desktop Controller: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

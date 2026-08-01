import { parseDesktopControllerArguments, runDesktopController } from "./production-controller.js";

const abort = new AbortController();
const stop = (): void => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await runDesktopController(parseDesktopControllerArguments(process.argv.slice(2)), abort.signal);
} catch (error) {
  console.error(
    `codexhost Desktop Controller: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

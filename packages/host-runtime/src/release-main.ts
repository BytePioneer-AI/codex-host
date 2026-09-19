import { runDelegationCli } from "./delegation-cli.js";
import { runHostRuntime } from "./run-host-runtime.js";
import { runRemoteControlAppServerBridge } from "./remote-control-app-server.js";
import { runRemoteHostCli } from "./remote-host-cli.js";
import { runClaudeAquaHarnessBroker } from "./aqua-harness-broker.js";
import { installRuntimeLog, runtimeLogPath } from "./runtime-log.js";

const arguments_ = process.argv.slice(2);

// Only the long-lived Host Runtime is logged; the CLI subcommands report on their own stderr.
function runLoggedHostRuntime(): Promise<number> {
  installRuntimeLog({ filePath: runtimeLogPath(process.env), stream: process.stderr, process });
  return runHostRuntime({
    arguments: arguments_,
    environment: process.env,
    hostRuntimeUrl: import.meta.url,
  });
}

process.exitCode =
  arguments_[0] === "--codexhost-delegation-cli"
    ? await runDelegationCli({ arguments: arguments_.slice(1), environment: process.env })
    : arguments_[0] === "--codexhost-harness-broker"
      ? await runClaudeAquaHarnessBroker(process.env, arguments_[1] ?? "claude-code")
      : arguments_[0] === "--codexhost-remote"
        ? await runRemoteHostCli({ arguments: arguments_.slice(1), environment: process.env })
        : arguments_[0] === "--codexhost-remote-control-bridge"
          ? await runRemoteControlAppServerBridge()
          : await runLoggedHostRuntime();

import { runDelegationCli } from "./delegation-cli.js";
import { runHostRuntime } from "./run-host-runtime.js";
import { runRemoteControlAppServerBridge } from "./remote-control-app-server.js";
import { runRemoteHostCli } from "./remote-host-cli.js";

const arguments_ = process.argv.slice(2);
process.exitCode =
  arguments_[0] === "--codexhost-delegation-cli"
    ? await runDelegationCli({ arguments: arguments_.slice(1), environment: process.env })
    : arguments_[0] === "--codexhost-remote"
      ? await runRemoteHostCli({ arguments: arguments_.slice(1), environment: process.env })
      : arguments_[0] === "--codexhost-remote-control-bridge"
        ? await runRemoteControlAppServerBridge()
        : await runHostRuntime({
            arguments: arguments_,
            environment: process.env,
            hostRuntimeUrl: import.meta.url,
          });

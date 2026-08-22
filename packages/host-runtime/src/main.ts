import { runHostRuntime } from "./run-host-runtime.js";
import { runRemoteHostCli } from "./remote-host-cli.js";

const arguments_ = process.argv.slice(2);
process.exitCode =
  arguments_[0] === "--codexhost-remote"
    ? await runRemoteHostCli({ arguments: arguments_.slice(1), environment: process.env })
    : await runHostRuntime({ arguments: arguments_, environment: process.env });

import { spawnSync } from "node:child_process";

export const JS_ENTRYPOINT_MARKER = "// codexhost remote SSH node entrypoint v1";
export const JS_ENTRYPOINT_NODE_PLACEHOLDER = "/__CODEXHOST_JS_ENTRYPOINT_NODE__";

export function isGlibcLoaderFailure(text: string): boolean {
  return /GLIBC_\d/u.test(text) && /not found/iu.test(text);
}

export function nativeShimNeedsJsFallback(
  shimPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "linux") return false;
  const result = spawnSync(shimPath, [], {
    encoding: "utf8",
    timeout: 3_000,
    env: { ...process.env, CODEXHOST_STOCK_CODEX_PATH: "/nonexistent-codexhost-probe" },
  });
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}\n${result.error?.message ?? ""}`;
  return isGlibcLoaderFailure(text);
}

export function renderRemoteHostJsEntrypoint(nodePath: string): string {
  if (!nodePath.startsWith("/") || nodePath.includes("\n") || nodePath.includes("\0")) {
    throw new Error("Node entrypoint shebang requires an absolute path without newlines");
  }
  return `#!${nodePath}\n${JS_ENTRYPOINT_MARKER}\n${JS_ENTRYPOINT_SOURCE}`;
}

const JS_ENTRYPOINT_SOURCE = `
"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var net = require("net");
var path = require("path");

var VALUE_GLOBAL = [
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
];
var FLAG_GLOBAL = [
  "--strict-config",
  "--oss",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
];
var VALUE_APP_SERVER = [
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--listen",
  "--ws-auth",
  "--ws-token-file",
  "--ws-token-sha256",
  "--ws-shared-secret-file",
  "--ws-issuer",
  "--ws-audience",
  "--ws-max-clock-skew-seconds",
];
var FLAG_HOST = ["--strict-config", "--analytics-default-enabled"];
var FLAG_LISTEN = ["--strict-config", "--analytics-default-enabled"];

function hasPrefixEquals(argument, option) {
  return argument.indexOf(option + "=") === 0;
}

function appServerIndex(args) {
  var index = 0;
  while (index < args.length) {
    var argument = args[index];
    if (argument === "app-server") return index;
    if (VALUE_GLOBAL.indexOf(argument) >= 0) {
      if (index + 1 >= args.length) return -1;
      index += 2;
      continue;
    }
    var skip = false;
    for (var i = 0; i < VALUE_GLOBAL.length; i += 1) {
      if (hasPrefixEquals(argument, VALUE_GLOBAL[i])) {
        skip = true;
        break;
      }
    }
    if (skip || FLAG_GLOBAL.indexOf(argument) >= 0) {
      index += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

function shouldStartHostRuntime(args) {
  var start = appServerIndex(args);
  if (start < 0) return false;
  var index = start + 1;
  while (index < args.length) {
    var argument = args[index];
    if (VALUE_APP_SERVER.indexOf(argument) >= 0) {
      if (index + 1 >= args.length) return false;
      index += 2;
      continue;
    }
    var skip = false;
    for (var i = 0; i < VALUE_APP_SERVER.length; i += 1) {
      if (hasPrefixEquals(argument, VALUE_APP_SERVER[i])) {
        skip = true;
        break;
      }
    }
    if (skip || FLAG_HOST.indexOf(argument) >= 0) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function isDefaultRemoteUnixListener(args) {
  var start = appServerIndex(args);
  if (start < 0) return false;
  var index = start + 1;
  var sawDefault = false;
  while (index < args.length) {
    var argument = args[index];
    if (argument === "--stdio") return false;
    if (argument === "--listen") {
      var value = args[index + 1];
      if (!value || sawDefault || value !== "unix://") return false;
      sawDefault = true;
      index += 2;
      continue;
    }
    if (hasPrefixEquals(argument, "--listen")) {
      var listenValue = argument.slice("--listen=".length);
      if (sawDefault || listenValue !== "unix://") return false;
      sawDefault = true;
      index += 1;
      continue;
    }
    if (VALUE_APP_SERVER.indexOf(argument) >= 0) {
      if (index + 1 >= args.length) return false;
      index += 2;
      continue;
    }
    var skip = false;
    for (var i = 0; i < VALUE_APP_SERVER.length; i += 1) {
      if (argument !== "--listen" && hasPrefixEquals(argument, VALUE_APP_SERVER[i])) {
        skip = true;
        break;
      }
    }
    if (skip || FLAG_LISTEN.indexOf(argument) >= 0) {
      index += 1;
      continue;
    }
    return false;
  }
  return sawDefault;
}

function withoutEnv(extra) {
  var env = Object.assign({}, process.env, extra || {});
  delete env.CODEX_CLI_PATH;
  delete env.CODEXHOST_REMOTE_SSH_MANAGED;
  delete env.CODEXHOST_REMOTE_LISTENER_CHILD;
  return env;
}

function execForeground(command, commandArgs, extra) {
  var child = childProcess.spawn(command, commandArgs, {
    stdio: "inherit",
    env: extra,
  });
  child.on("error", function (error) {
    process.stderr.write(String(error.message || error) + "\\n");
    process.exit(1);
  });
  child.on("exit", function (code, signal) {
    if (signal) {
      try {
        process.kill(process.pid, signal);
      } catch (_error) {
        process.exit(1);
      }
      return;
    }
    process.exit(code == null ? 1 : code);
  });
}

function defaultSocketPath() {
  var home = process.env.CODEX_HOME;
  if (!home) {
    if (!process.env.HOME) throw new Error("CODEX_HOME or HOME is required for the remote listener");
    home = path.join(process.env.HOME, ".codex");
  }
  return path.join(home, "app-server-control", "app-server-control.sock");
}

function socketIdentity(socketPath) {
  try {
    var metadata = fs.statSync(socketPath);
    return String(metadata.dev) + ":" + String(metadata.ino);
  } catch (_error) {
    return null;
  }
}

function connectSocket(socketPath) {
  return new Promise(function (resolve) {
    var socket = net.createConnection(socketPath);
    var settled = false;
    var finish = function (ok) {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_error) {}
      resolve(ok);
    };
    socket.once("connect", function () {
      finish(true);
    });
    socket.once("error", function () {
      finish(false);
    });
    setTimeout(function () {
      finish(false);
    }, 200);
  });
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function stopChild(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (_error) {
    try {
      child.kill("SIGTERM");
    } catch (_ignored) {}
  }
}

async function waitForListener(child, previousIdentity) {
  var socketPath = defaultSocketPath();
  var deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(
        "managed remote listener exited before readiness: " +
          String(child.exitCode != null ? child.exitCode : child.signalCode),
      );
    }
    var current = socketIdentity(socketPath);
    if (current && current !== previousIdentity && (await connectSocket(socketPath))) {
      await sleep(20);
      if (child.exitCode != null || child.signalCode != null) {
        throw new Error("managed remote listener exited after readiness");
      }
      return;
    }
    await sleep(20);
  }
  stopChild(child);
  throw new Error(
    "managed remote listener did not become ready at " + socketPath + " within 10 seconds",
  );
}

function hasDefaultListener(args) {
  var joined = args.join(" ");
  var appServer = args.indexOf("app-server") >= 0 || joined.indexOf(" app-server ") >= 0;
  var exact = false;
  for (var i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--listen" && args[i + 1] === "unix://") exact = true;
  }
  for (var j = 0; j < args.length; j += 1) {
    if (args[j] === "--listen=unix://") exact = true;
  }
  var shell =
    args.length === 1 &&
    (joined.indexOf(" --listen unix://") >= 0 || joined.indexOf(" --listen=unix://") >= 0);
  var proxy = args.indexOf("proxy") >= 0 || joined.indexOf(" app-server proxy") >= 0;
  return appServer && (exact || shell) && !proxy;
}

function mentionsPath(args, expected) {
  for (var i = 0; i < args.length; i += 1) {
    if (args[i] === expected) return true;
  }
  if (args.length === 1) {
    var parts = args[0].split(/\\s+/);
    for (var j = 0; j < parts.length; j += 1) {
      var token = parts[j].replace(/^[\\'\"]+|[\\'\"]+$/g, "");
      if (token === expected) return true;
    }
  }
  return false;
}

function readCmdline(pid) {
  try {
    return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function readPpid(pid) {
  try {
    var stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    var close = stat.lastIndexOf(")");
    var rest = stat.slice(close + 2).split(" ");
    return Number(rest[1]);
  } catch (_error) {
    return 0;
  }
}

function readExe(pid) {
  try {
    return fs.realpathSync("/proc/" + pid + "/exe");
  } catch (_error) {
    return "";
  }
}

function listPids() {
  try {
    return fs
      .readdirSync("/proc")
      .filter(function (name) {
        return /^\\d+$/.test(name);
      })
      .map(Number);
  } catch (_error) {
    return [];
  }
}

function socketOwners(socketPath) {
  var fromLsof = childProcess.spawnSync("lsof", ["-t", socketPath], { encoding: "utf8" });
  if (fromLsof.status === 0 && fromLsof.stdout) {
    return fromLsof.stdout
      .trim()
      .split(/\\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(function (pid) {
        return pid > 0;
      });
  }
  var owners = [];
  try {
    var socketText = socketPath;
    var inodes = {};
    var lines = fs.readFileSync("/proc/net/unix", "utf8").split("\\n");
    for (var i = 0; i < lines.length; i += 1) {
      var fields = lines[i].trim().split(/\\s+/);
      if (fields[7] === socketText && fields[6]) inodes[fields[6]] = true;
    }
    var pids = listPids();
    for (var p = 0; p < pids.length; p += 1) {
      var pid = pids[p];
      var fdDir = "/proc/" + pid + "/fd";
      var fds;
      try {
        fds = fs.readdirSync(fdDir);
      } catch (_error) {
        continue;
      }
      for (var f = 0; f < fds.length; f += 1) {
        try {
          var target = fs.readlinkSync(fdDir + "/" + fds[f]);
          var match = /^socket:\\[(\\d+)\\]$/.exec(target);
          if (match && inodes[match[1]]) {
            owners.push(pid);
            break;
          }
        } catch (_ignored) {}
      }
    }
  } catch (_error) {}
  return owners;
}

function killTree(rootPid) {
  var pids = listPids();
  var selected = {};
  selected[rootPid] = true;
  var changed = true;
  while (changed) {
    changed = false;
    for (var i = 0; i < pids.length; i += 1) {
      var pid = pids[i];
      if (!selected[pid] && selected[readPpid(pid)]) {
        selected[pid] = true;
        changed = true;
      }
    }
  }
  var tree = Object.keys(selected).map(Number);
  tree.sort(function (left, right) {
    if (left === rootPid) return 1;
    if (right === rootPid) return -1;
    return left - right;
  });
  for (var t = 0; t < tree.length; t += 1) {
    try {
      process.kill(tree[t], "SIGTERM");
    } catch (_error) {}
  }
  var deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    var live = false;
    for (var l = 0; l < tree.length; l += 1) {
      try {
        process.kill(tree[l], 0);
        live = true;
      } catch (_error) {}
    }
    if (!live) return;
    var spinUntil = Date.now() + 25;
    while (Date.now() < spinUntil) {}
  }
  for (var k = 0; k < tree.length; k += 1) {
    try {
      process.kill(tree[k], "SIGKILL");
    } catch (_error) {}
  }
}

function realPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (_error) {
    return filePath;
  }
}

function matchingRoot(ownerPid, role, stockPath, nodePath, runtimePath) {
  var expectedNode = realPath(nodePath);
  var expectedStock = realPath(stockPath);
  var expectedCommand = role === "stock" ? stockPath : runtimePath;
  var current = ownerPid;
  for (var depth = 0; depth < 32 && current > 0; depth += 1) {
    var exe = readExe(current);
    var args = readCmdline(current);
    var matches = false;
    if (role === "stock") {
      var exeMatches =
        exe === expectedStock || (exe === expectedNode && mentionsPath(args, expectedCommand));
      matches = exeMatches && hasDefaultListener(args);
    } else {
      matches =
        exe === expectedNode &&
        mentionsPath(args, expectedCommand) &&
        hasDefaultListener(args);
    }
    if (matches) return current;
    current = readPpid(current);
  }
  return 0;
}

function runTerminate(args) {
  var role = args[0];
  if (role !== "stock" && role !== "managed") {
    throw new Error("remote listener role must be 'stock' or 'managed'");
  }
  var options = {};
  for (var i = 1; i < args.length; i += 2) {
    var option = args[i];
    var value = args[i + 1];
    if (!value) throw new Error(option + " requires a path");
    if (option === "--socket") options.socket = value;
    else if (option === "--stock-codex") options.stock = value;
    else if (option === "--node") options.node = value;
    else if (option === "--host-runtime") options.runtime = value;
    else throw new Error("unknown remote lifecycle option '" + option + "'");
  }
  if (!options.socket || !options.stock || !options.node || !options.runtime) {
    throw new Error("terminate requires --socket, --stock-codex, --node, and --host-runtime");
  }
  var owners = socketOwners(options.socket);
  if (owners.length === 0) {
    throw new Error("no process owns remote Host socket " + options.socket);
  }
  var roots = [];
  for (var o = 0; o < owners.length; o += 1) {
    var root = matchingRoot(owners[o], role, options.stock, options.node, options.runtime);
    if (root && roots.indexOf(root) < 0) roots.push(root);
  }
  if (roots.length !== 1) {
    throw new Error("remote Host socket owner does not match the requested installed listener");
  }
  killTree(roots[0]);
  process.stdout.write("terminated_pid=" + String(roots[0]) + "\\n");
}

function startHostOrStock(args) {
  var stock = process.env.CODEXHOST_STOCK_CODEX_PATH;
  var nodePath = process.env.CODEXHOST_HOST_NODE_PATH || process.execPath;
  var runtimePath = process.env.CODEXHOST_HOST_RUNTIME_PATH;
  if (shouldStartHostRuntime(args) && runtimePath) {
    var hostEnv = withoutEnv({
      CODEXHOST_STOCK_CODEX_PATH: stock,
      CODEXHOST_HOST_NODE_PATH: nodePath,
      CODEXHOST_HOST_RUNTIME_PATH: runtimePath,
    });
    execForeground(nodePath, [runtimePath].concat(args), hostEnv);
    return;
  }
  if (!stock) {
    process.stderr.write("CODEXHOST_STOCK_CODEX_PATH is required\\n");
    process.exit(1);
  }
  var stockEnv = withoutEnv({});
  delete stockEnv.CODEXHOST_HOST_NODE_PATH;
  delete stockEnv.CODEXHOST_HOST_RUNTIME_PATH;
  execForeground(stock, args, stockEnv);
}

async function main(args) {
  if (process.env.CODEXHOST_JS_ENTRYPOINT_SELFTEST === "1") {
    var assert = require("assert");
    assert.equal(shouldStartHostRuntime(["app-server"]), true);
    assert.equal(
      shouldStartHostRuntime(["-c", "features.code_mode_host=true", "app-server", "--listen", "unix://"]),
      true,
    );
    assert.equal(shouldStartHostRuntime(["app-server", "proxy"]), false);
    assert.equal(shouldStartHostRuntime(["app-server", "generate-json-schema"]), false);
    assert.equal(isDefaultRemoteUnixListener(["app-server", "--listen", "unix://"]), true);
    assert.equal(
      isDefaultRemoteUnixListener(["-c", "features.code_mode_host=true", "app-server", "--listen", "unix://"]),
      true,
    );
    assert.equal(isDefaultRemoteUnixListener(["app-server", "--listen=unix://"]), true);
    assert.equal(isDefaultRemoteUnixListener(["app-server", "proxy"]), false);
    assert.equal(isDefaultRemoteUnixListener(["app-server", "--stdio"]), false);
    assert.equal(
      isDefaultRemoteUnixListener(["app-server", "--stdio", "--listen", "unix://"]),
      false,
    );
    assert.equal(
      isDefaultRemoteUnixListener(["app-server", "--listen", "unix:///tmp/custom.sock"]),
      false,
    );
    process.stdout.write("ok\\n");
    return;
  }
  if (args[0] === "--codexhost-remote-terminate") {
    runTerminate(args.slice(1));
    return;
  }
  var managed = process.env.CODEXHOST_REMOTE_SSH_MANAGED === "1";
  var isChild = process.env.CODEXHOST_REMOTE_LISTENER_CHILD === "1";
  if (managed && isDefaultRemoteUnixListener(args)) {
    if (!isChild) {
      var previous = socketIdentity(defaultSocketPath());
      var childEnv = Object.assign({}, process.env, { CODEXHOST_REMOTE_LISTENER_CHILD: "1" });
      var child = childProcess.spawn(process.execPath, [__filename].concat(args), {
        detached: true,
        stdio: "ignore",
        env: childEnv,
      });
      child.unref();
      await waitForListener(child, previous);
      process.exit(0);
    }
  }
  startHostOrStock(args);
}

main(process.argv.slice(2)).catch(function (error) {
  process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
  process.exit(1);
});
`;

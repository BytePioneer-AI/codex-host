// Experimental live pairing probe, not registered as a Harness backend.
// Pairing material enters through stdin only. No account files, clipboard APIs, or debug ports.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { bounded, PairedRelay, parsePairingUrl, ProbeError } from "./paired-relay.mjs";
import { probePairedCatalog } from "./paired-catalog.mjs";

const resources = "/Applications/ZCode.app/Contents/Resources";
const executable = "/Applications/ZCode.app/Contents/MacOS/ZCode";
const report = (stage, detail = {}) => console.log(JSON.stringify({ stage, ...detail }));
const help = `Experimental ZCode Desktop 3.12.3 pairing probe (macOS only).
  node packages/adapters/zcode/prototypes/paired-desktop.mjs --check
  pbpaste | node packages/adapters/zcode/prototypes/paired-desktop.mjs --cwd "$PWD" --pairing-stdin

For live use: enable Web Remote Control in ZCode and copy its native connection URL first.
The probe uses the official Relay, may replace a phone connection, and creates/closes ONLY
its own deferred empty Session. No prompt, Provider configuration, or account credential RPC.
Do not paste pairing URLs into chat, command arguments, logs or tracked files.
--check verifies the installed private codec without connecting to the Relay.
`;

function options() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (args.length === 1 && args[0] === "--check") return { check: true };
  if (
    args.length !== 3 ||
    args[0] !== "--cwd" ||
    !path.isAbsolute(args[1]) ||
    args[2] !== "--pairing-stdin"
  )
    throw new ProbeError("invalid-arguments-use-help");
  return { cwd: args[1] };
}

async function launch(config) {
  if (process.platform !== "darwin") throw new ProbeError("macos-only-prototype");
  if (!config.check && process.stdin.isTTY) throw new ProbeError("pairing-input-required");
  const root = await realpath(await mkdtemp("/tmp/zcp-"));
  let child, timer;
  const terminate = () => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  try {
    await mkdir(path.join(root, "tmp"));
    for (const name of ["paired-desktop.mjs", "paired-relay.mjs", "paired-catalog.mjs"]) {
      await copyFile(new URL(name, import.meta.url), path.join(root, name));
    }
    const quote = JSON.stringify;
    const policy = `(version 1)(allow default)
(deny signal)
(deny file-write*)
(allow file-write* (subpath ${quote(root)}) (literal "/dev/null"))
(deny file-read* file-write* (subpath ${quote(await realpath(homedir()))}))
(deny network-inbound)
(deny process-exec (literal "/usr/bin/open"))`;
    child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        policy,
        executable,
        path.join(root, "paired-desktop.mjs"),
        ...(config.check ? ["--check"] : ["--cwd", config.cwd, "--pairing-stdin"]),
      ],
      {
        cwd: root,
        detached: true,
        stdio: ["pipe", "inherit", "inherit"],
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: root,
          USERPROFILE: root,
          TMPDIR: path.join(root, "tmp"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          ELECTRON_RUN_AS_NODE: "1",
          CODEXHOST_ZCODE_PAIRED_PROBE_CHILD: "1",
        },
      },
    );
    child.stdin.on("error", () => {}); // Do not dump input or EPIPE details if validation exits early.
    if (config.check) child.stdin.end();
    else process.stdin.pipe(child.stdin);
    timer = setTimeout(terminate, 90_000);
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", () => reject(new ProbeError("could-not-launch-probe")));
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(timer);
    process.stdin.unpipe(child?.stdin);
    process.stdin.pause();
    terminate();
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
    await rm(root, { recursive: true, force: true });
  }
}

async function nativeClient() {
  try {
    const pkg = JSON.parse(await readFile(`${resources}/app.asar/package.json`, "utf8"));
    if (pkg.version !== "3.12.3") throw new Error();
    const rpcModule = await import(`${resources}/app.asar/out/host/chunk-PRPNU2MC.js`);
    const relayModule = await import(`${resources}/app.asar/out/main/chunk-E6IDJBYU.js`);
    const exported = (module, name) => {
      const values = Object.values(module).filter(
        (value) => typeof value === "function" && value.name === name,
      );
      assert.equal(values.length, 1);
      return values[0];
    };
    const ChannelClient = exported(rpcModule, "ChannelClient");
    const createProtocol = exported(relayModule, "createAcknowledgedWebRemoteControlRelayProtocol");
    return { createProtocol, createRpc: (protocol) => new ChannelClient(protocol) };
  } catch {
    throw new ProbeError("installed-native-protocol-not-supported");
  }
}

async function readPairing() {
  const read = async () => {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 8192) throw new ProbeError("pairing-input-too-large");
      chunks.push(chunk);
    }
    return parsePairingUrl(Buffer.concat(chunks).toString("utf8"));
  };
  try {
    return await bounded(read(), 20_000, "pairing-input-timeout");
  } finally {
    process.stdin.destroy();
  }
}

async function checkCodec({ createProtocol }) {
  let left, right;
  const deliver = (target, frame) => {
    queueMicrotask(() => target().acceptPayload(frame));
    return true;
  };
  const identity = { bridgeSessionId: "probe-codec", bridgeGeneration: 1 };
  try {
    left = createProtocol({ ...identity, sendFrame: (frame) => deliver(() => right, frame) });
    right = createProtocol({ ...identity, sendFrame: (frame) => deliver(() => left, frame) });
    const received = new Promise((resolve) =>
      right.protocol.onMessage((message) => resolve(Buffer.from(message.buffer).toString("utf8"))),
    );
    left.protocol.send({ buffer: Buffer.from("codexhost-native-relay-codec") });
    assert.equal(
      await bounded(received, 2000, "native-codec-timeout"),
      "codexhost-native-relay-codec",
    );
    report("native-relay-codec-passed", { desktop: "3.12.3", networkUsed: false });
  } finally {
    left?.dispose();
    right?.dispose();
  }
}

async function run(config) {
  const native = await nativeClient();
  if (config.check) return checkCodec(native);
  const pairing = await readPairing();
  const relay = new PairedRelay(pairing);
  try {
    await relay.connect();
    report("paired");
    const result = await probePairedCatalog(relay, { cwd: config.cwd, ...native });
    report("catalog-probe-passed", result);
  } finally {
    relay.close();
  }
}

// Never print arbitrary exception messages, stack traces, native snapshots or pairing material.
try {
  const config = options();
  if (config.help) console.log(help);
  else if (process.env.CODEXHOST_ZCODE_PAIRED_PROBE_CHILD !== "1") await launch(config);
  else {
    const deadline = setTimeout(() => {
      report("failed", { code: "probe-timeout-cleanup-unconfirmed" });
      process.exit(1);
    }, 75_000);
    try {
      await run(config);
    } finally {
      clearTimeout(deadline);
    }
  }
} catch (error) {
  report("failed", { code: error instanceof ProbeError ? error.code : "probe-failed" });
  process.exitCode = 1;
}

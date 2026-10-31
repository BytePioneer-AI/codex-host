const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { NativeConnection } = require("./native.cjs");
const { DesktopService } = require("./service.cjs");
const { startServer } = require("./server.cjs");

let current;

async function activate(context) {
  const vscode = require("vscode");
  const product = JSON.parse(
    await fs.readFile(path.join(vscode.env.appRoot, "product.json"), "utf8"),
  );
  if (product.applicationName !== "trae-cn")
    throw new Error("This bridge requires TRAE CN Desktop");
  const application = {
    name: product.nameShort,
    version: product.appVersion,
    root: vscode.env.appRoot,
    executable: process.execPath,
  };
  const directory =
    process.env.CODEXHOST_TRAE_CN_BRIDGE_DIR ||
    path.join(os.homedir(), ".codexhost", "native-bridges", "trae-cn");
  if (!path.isAbsolute(directory)) throw new Error("CODEXHOST_TRAE_CN_BRIDGE_DIR must be absolute");
  const output = vscode.window.createOutputChannel("CodexHost TRAE CN Bridge");
  context.subscriptions.push(output);
  let native;
  let bridge;
  let closing = false;
  let transition = Promise.resolve();
  const getNative = () => {
    if (closing)
      throw Object.assign(new Error("TRAE CN Companion is closing"), { code: "invalidState" });
    if (!vscode.workspace.isTrusted)
      throw Object.assign(new Error("Trust this TRAE CN workspace before connecting CodexHost"), {
        code: "configurationRequired",
      });
    if (!native || native.closed) {
      const channel = require("electron").ahaIpc.connect("ai-agent");
      if (!channel)
        throw Object.assign(new Error("TRAE CN native Agent is unavailable"), {
          code: "unavailable",
        });
      native = new NativeConnection(channel, vscode, randomUUID());
    }
    return native;
  };
  const stop = async () => {
    const previous = bridge;
    bridge = undefined;
    try {
      await previous?.close();
    } finally {
      native?.close();
      native = undefined;
    }
  };
  const restart = () => {
    const task = transition.then(async () => {
      await stop();
      if (closing) return;
      const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
      const nativePort = {
        call: (...args) => getNative().call(...args),
        subscribe: (...args) => getNative().subscribe(...args),
      };
      const service = new DesktopService(nativePort, application, folders);
      bridge = await startServer(service, directory);
      output.appendLine(`Bridge ready for ${folders.length} workspace folder(s)`);
    });
    transition = task.catch(() =>
      output.appendLine(
        "Bridge startup failed. Check workspace trust and the TRAE CN native runtime.",
      ),
    );
    return task;
  };
  current = {
    async close() {
      closing = true;
      await transition;
      await stop();
    },
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("codexhost.traeCn.restartBridge", restart),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void restart().catch(() => {});
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void restart().catch(() => {});
    }),
  );
  await restart();
  return { restart };
}

async function deactivate() {
  const previous = current;
  current = undefined;
  await previous?.close();
}

module.exports = { activate, deactivate };

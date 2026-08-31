import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  classifyRemoteSshOccupancy,
  remoteSshPreflightParamsSchema,
  remoteSshPreflightResultSchema,
  remoteSshProvisionParamsSchema,
  sshTargetFromRemoteHostId,
  type RemoteSshOccupancyKind,
  type RemoteSshPreflightParams,
  type RemoteSshPreflightResult,
  type RemoteSshProvisionParams,
  type RemoteSshProvisionResult,
} from "@codexhost/shared-contracts";

import {
  JS_ENTRYPOINT_MARKER,
  JS_ENTRYPOINT_NODE_PLACEHOLDER,
  renderRemoteHostJsEntrypoint,
} from "./remote-host-js-entrypoint.js";

export const REMOTE_SSH_PREFLIGHT_METHOD = "codexhost/remote-ssh/preflight";
export const REMOTE_SSH_PROVISION_METHOD = "codexhost/remote-ssh/provision";
export const REMOTE_SSH_PROVISION_LOG_METHOD = "codexhost/remote-ssh/provision/log";

export function remoteSshPreflightScript(): string {
  return [
    "python3 - <<'PY'",
    "import json, os, pathlib, shutil, subprocess",
    "home = pathlib.Path.home()",
    "codex_home = pathlib.Path(os.environ.get('CODEX_HOME') or home / '.codex')",
    "sock = codex_home / 'app-server-control' / 'app-server-control.sock'",
    "grok = shutil.which('grok')",
    "owner_command = None",
    "if sock.exists():",
    "    try:",
    "        pids = subprocess.check_output(['lsof', '-t', str(sock)], text=True).split()",
    "        if pids:",
    "            owner_command = subprocess.check_output(['ps', '-o', 'args=', '-p', pids[0]], text=True).strip()",
    "    except Exception:",
    "        owner_command = 'socket-exists'",
    "print(json.dumps({'grokPath': grok, 'ownerCommand': owner_command}))",
    "PY",
    "",
  ].join("\n");
}

export function occupancyMessage(kind: RemoteSshOccupancyKind, sshTarget: string): string {
  switch (kind) {
    case "idle":
      return `可以在 ${sshTarget} 上安装 CodexHost 远程入口。`;
    case "grok-missing":
      return `${sshTarget} 上还没有 Grok CLI，请先在服务器安装并登录。`;
    case "official-remote-control":
      return `目前 ${sshTarget} 上面已经运行着 Codex SSH daemon，需要你的允许才能换成 CodexHost 总入口。`;
    case "unknown-busy":
      return `${sshTarget} 上默认 socket 已被其他进程占用，不会自动接管。`;
  }
}

export function remoteGrokProvisionScript(replaceOfficialDaemon = false): string {
  const stopOfficial = replaceOfficialDaemon
    ? [
        'echo "==> 正在停止当前用户的官方 Codex SSH daemon"',
        "python3 - <<'PY'",
        "import os, signal, subprocess, sys",
        "try:",
        "    out = subprocess.check_output(['ps', '-u', str(os.getuid()), '-o', 'pid=,args='], text=True)",
        "except Exception as error:",
        "    print(error)",
        "    sys.exit(2)",
        "stopped = 0",
        "for line in out.splitlines():",
        "    line = line.strip()",
        "    if not line: continue",
        "    pid_text, _, args = line.partition(' ')",
        "    if 'app-server' in args and '--remote-control' in args and '--listen' in args:",
        "        os.kill(int(pid_text), signal.SIGTERM)",
        "        print(f'stopped pid {pid_text}')",
        "        stopped += 1",
        "if stopped == 0:",
        "    print('no official --remote-control daemon found for this user')",
        "    sys.exit(2)",
        "PY",
      ]
    : [];
  const restoreOfficial = replaceOfficialDaemon
    ? [
        'echo "==> 正在恢复这条 SSH 连接的官方 Codex SSH daemon"',
        "if command -v codex >/dev/null 2>&1; then",
        "  set +e",
        "  codex app-server daemon start",
        "  restore_code=$?",
        "  set -e",
        '  if [ "$restore_code" -ne 0 ]; then',
        '    echo "官方 Codex SSH daemon 没能自动恢复，请在服务器上执行: codex app-server daemon start"',
        "  fi",
        "fi",
      ]
    : [];
  return [
    "set -eu",
    'echo "==> 检查 Grok"',
    "if ! command -v grok >/dev/null 2>&1; then",
    '  echo "服务器上没有 Grok CLI，请先安装并登录。"',
    "  exit 2",
    "fi",
    'GROK_BIN="$(command -v grok)"',
    'echo "Grok: $GROK_BIN"',
    ...stopOfficial,
    'echo "==> 安装 @codexhost/cli"',
    "if ! command -v npm >/dev/null 2>&1; then",
    '  echo "服务器上没有 npm。"',
    "  exit 2",
    "fi",
    "npm install -g @codexhost/cli",
    'export CODEXHOST_GROK_COMMAND="$GROK_BIN"',
    "rollback() {",
    '  echo "==> 正在回滚远程 Host 安装"',
    "  codexhost remote uninstall || true",
    ...restoreOfficial,
    "}",
    'echo "==> 安装远程 Host"',
    "if codexhost remote help 2>&1 | grep -q -- '--grok-command'; then",
    '  echo "CLI 支持 --grok-command"',
    '  codexhost remote install --grok-command "$GROK_BIN"',
    "else",
    '  echo "当前 CLI 没有 --grok-command，将用 PATH 和 CODEXHOST_GROK_COMMAND 发现 Grok"',
    "  codexhost remote install",
    "fi",
    'echo "==> 检查原生入口是否能在这台 Linux 上加载"',
    "python3 - <<'PY'",
    "import hashlib, json, os, pathlib, subprocess, sys",
    "home = pathlib.Path.home()",
    "manifest_path = home / '.codexhost' / 'remote' / 'manifest.json'",
    "if not manifest_path.is_file():",
    "    print('找不到远程 Host 安装清单')",
    "    sys.exit(2)",
    "manifest = json.loads(manifest_path.read_text())",
    "wrapper = pathlib.Path(manifest['wrapperPath'])",
    "probe = subprocess.run([str(wrapper)], capture_output=True, text=True)",
    "text = (probe.stderr or '') + '\\n' + (probe.stdout or '')",
    "if 'GLIBC_' in text and 'not found' in text.lower():",
    "    node = manifest.get('nodePath') or ''",
    "    if not node or not os.access(node, os.X_OK):",
    "        print('原生入口需要更高 glibc，但清单里的 Node 不可用')",
    "        sys.exit(2)",
    `    script = ${JSON.stringify(renderRemoteHostJsEntrypoint(JS_ENTRYPOINT_NODE_PLACEHOLDER))}`,
    `    if ${JSON.stringify(JS_ENTRYPOINT_MARKER)} not in script:`,
    "        print('Node 入口脚本生成失败')",
    "        sys.exit(2)",
    `    script = script.replace(${JSON.stringify(JS_ENTRYPOINT_NODE_PLACEHOLDER)}, node, 1)`,
    "    wrapper.write_text(script)",
    "    os.chmod(wrapper, 0o700)",
    "    digest = hashlib.sha256(wrapper.read_bytes()).hexdigest()",
    "    manifest['entrypointSha256'] = digest",
    "    manifest_path.write_text(json.dumps(manifest, indent=2) + '\\n')",
    "    print('原生入口需要更高 glibc，已改用 Node 入口：' + str(wrapper))",
    "else:",
    "    print('原生入口可以加载，保持不变')",
    "PY",
    'echo "==> 启动远程 Host"',
    "set +e",
    "codexhost remote start",
    "start_code=$?",
    "set -e",
    'if [ "$start_code" -ne 0 ]; then',
    "  rollback",
    '  echo "远程 Host 没能启动，已卸载回滚，并尝试恢复这条 SSH 连接的官方 Codex SSH daemon。"',
    "  exit 3",
    "fi",
    'echo "==> 状态"',
    "codexhost remote status",
    'echo "==> 完成。这条 SSH 连接的入口已重新建立。请重新打开这个远程项目，然后再选 Agent。"',
    "",
  ].join("\n");
}

export interface RemoteSshProvisionDependencies {
  spawnSsh(sshTarget: string, script: string, onChunk: (chunk: string) => void): Promise<number>;
}

function defaultSpawnSsh(
  sshTarget: string,
  script: string,
  onChunk: (chunk: string) => void,
): Promise<number> {
  const child: ChildProcessWithoutNullStreams = spawn(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-T", sshTarget, "bash", "-s"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.write(script);
  child.stdin.end();
  const emit = (data: Buffer | string): void => {
    const text = data.toString();
    if (text.length > 0) onChunk(text);
  };
  child.stdout.on("data", emit);
  child.stderr.on("data", emit);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export function resolveRemoteSshProvisionTarget(
  params: RemoteSshProvisionParams | RemoteSshPreflightParams,
): string | null {
  const parsed = remoteSshProvisionParamsSchema.partial().parse(params);
  if (parsed.sshTarget) return parsed.sshTarget;
  if (!parsed.hostId) return null;
  return sshTargetFromRemoteHostId(parsed.hostId);
}

function parseTrailingJsonObject(text: string): {
  grokPath: string | null;
  ownerCommand: string | null;
} {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith("{")) continue;
    const value = JSON.parse(line) as {
      grokPath?: unknown;
      ownerCommand?: unknown;
    };
    return {
      grokPath: typeof value.grokPath === "string" ? value.grokPath : null,
      ownerCommand: typeof value.ownerCommand === "string" ? value.ownerCommand : null,
    };
  }
  throw new Error("远程 SSH 预检没有返回占用信息");
}

export async function preflightRemoteSshGrokHost(input: {
  params: RemoteSshPreflightParams;
  environment?: NodeJS.ProcessEnv;
  onLog?(chunk: string): void | Promise<void>;
  dependencies?: Partial<RemoteSshProvisionDependencies>;
}): Promise<RemoteSshPreflightResult> {
  const environment = input.environment ?? process.env;
  if (environment.CODEXHOST_REMOTE_SSH_MANAGED === "1") {
    throw new Error("远程 Host 预检必须从本机 Desktop 发起");
  }
  const parsed = remoteSshPreflightParamsSchema.parse(input.params);
  const sshTarget = resolveRemoteSshProvisionTarget(parsed);
  if (!sshTarget) {
    throw new Error("无法从远程 Host ID 解析 SSH 目标");
  }
  const spawnSsh = input.dependencies?.spawnSsh ?? defaultSpawnSsh;
  const chunks: string[] = [];
  const onChunk = (chunk: string): void => {
    chunks.push(chunk);
    void input.onLog?.(chunk);
  };
  onChunk(`$ ssh ${sshTarget} preflight\n`);
  const code = await spawnSsh(sshTarget, remoteSshPreflightScript(), onChunk);
  if (code !== 0) {
    throw new Error(`远程 SSH 预检失败，退出码 ${code}\n${chunks.join("").trim()}`.slice(0, 4000));
  }
  const occupancy = parseTrailingJsonObject(chunks.join(""));
  const kind = classifyRemoteSshOccupancy(occupancy);
  return remoteSshPreflightResultSchema.parse({
    sshTarget,
    kind,
    grokPath: occupancy.grokPath,
    ownerCommand: occupancy.ownerCommand,
    message: occupancyMessage(kind, sshTarget),
  });
}

export async function provisionRemoteSshGrokHost(input: {
  params: RemoteSshProvisionParams;
  environment?: NodeJS.ProcessEnv;
  onLog?(chunk: string): void | Promise<void>;
  dependencies?: Partial<RemoteSshProvisionDependencies>;
}): Promise<RemoteSshProvisionResult> {
  const environment = input.environment ?? process.env;
  if (environment.CODEXHOST_REMOTE_SSH_MANAGED === "1") {
    throw new Error("远程 Host 安装必须从本机 Desktop 发起");
  }
  const params = remoteSshProvisionParamsSchema.parse(input.params);
  const sshTarget = resolveRemoteSshProvisionTarget(params);
  if (!sshTarget) {
    throw new Error("无法从远程 Host ID 解析 SSH 目标");
  }
  const preflight = await preflightRemoteSshGrokHost({
    params: {
      hostId: params.hostId,
      ...(params.sshTarget ? { sshTarget: params.sshTarget } : {}),
    },
    environment,
    ...(input.onLog ? { onLog: input.onLog } : {}),
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  });
  if (preflight.kind === "official-remote-control" && params.replaceOfficialDaemon !== true) {
    return {
      ok: false,
      sshTarget,
      kind: preflight.kind,
      message: preflight.message,
      reconnectRequired: false,
    };
  }
  if (preflight.kind === "unknown-busy") {
    return {
      ok: false,
      sshTarget,
      kind: preflight.kind,
      message: preflight.message,
      reconnectRequired: false,
    };
  }
  if (preflight.kind === "grok-missing") {
    return {
      ok: false,
      sshTarget,
      kind: preflight.kind,
      message: preflight.message,
      reconnectRequired: false,
    };
  }
  const spawnSsh = input.dependencies?.spawnSsh ?? defaultSpawnSsh;
  const chunks: string[] = [];
  const onChunk = (chunk: string): void => {
    chunks.push(chunk);
    void input.onLog?.(chunk);
  };
  onChunk(`$ ssh ${sshTarget} bash -s\n`);
  const code = await spawnSsh(
    sshTarget,
    remoteGrokProvisionScript(params.replaceOfficialDaemon === true),
    onChunk,
  );
  if (code !== 0) {
    throw new Error(
      `远程 Grok 入口安装失败，退出码 ${code}\n${chunks.join("").trim()}`.slice(0, 4000),
    );
  }
  return {
    ok: true,
    sshTarget,
    kind: preflight.kind,
    message: "远程 Grok 入口已装好。请重新打开这个远程项目，然后再选 Grok。",
    reconnectRequired: true,
  };
}

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GATEWAY_LAUNCH } from "../src/gateway-transport.js";

const python = ["python3", "python"].find(
  (command) =>
    spawnSync(command, ["-I", "-c", "import sys; assert sys.version_info >= (3, 9)"], {
      stdio: "ignore",
      timeout: 3000,
      windowsHide: true,
    }).status === 0,
);
const limit = 8 * 1024 * 1024;
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

// Only native discovery and the WebSocket are fixtures. stdin remains a real
// parent/child pipe, including blocking reads, EOF and interpreter shutdown.
const fixture = `import asyncio
import builtins
import hashlib
import json
import sys
import types


def module(name, **attrs):
    result = types.ModuleType(name)
    result.__dict__.update(attrs)
    sys.modules[name] = result


module("hermes_constants", get_hermes_home=lambda: "fixture")
module("hermes_cli")
module("hermes_cli.gateway_client", _session_ticket=lambda *args: "fixture",
       gateway_ws_target=lambda *args: ("fixture", []))
module("hermes_cli.gateway_runtime", attachable=lambda result: True,
       ensure_gateway_runtime=lambda *args, **kwargs: types.SimpleNamespace(endpoint="fixture"),
       gateway_profile_home=lambda home: home)
module("gateway")
module("gateway.session_contract", CANONICAL_GATEWAY_PROTOCOL="fixture")
module("websockets")
module("websockets.asyncio")


class WebSocket:
    subprotocol = "fixture"

    async def __aenter__(self):
        self.reading = asyncio.Event()
        self.sent = []
        loop = asyncio.get_running_loop()

        class ReadProbe:
            def __init__(probe, stream):
                probe.stream = stream

            def readline(probe, *args):
                loop.call_soon_threadsafe(self.reading.set)
                if sys.argv[1] == "read-error":
                    raise OSError("fixture stdin read failed")
                return probe.stream.readline(*args)

            def __getattr__(probe, name):
                return getattr(probe.stream, name)

        # Signal remote closure only once a real stdin read is about to block.
        # Cover both sys.stdin.buffer and independently opened fd-0 readers.
        original_stdin = sys.stdin
        class StdinProbe:
            buffer = ReadProbe(original_stdin.buffer)

            def __getattr__(probe, name):
                return getattr(original_stdin, name)

        sys.stdin = StdinProbe()
        original_open = builtins.open
        def open_probe(file, *args, **kwargs):
            stream = original_open(file, *args, **kwargs)
            return ReadProbe(stream) if file == 0 else stream
        builtins.open = open_probe
        return self

    async def __aexit__(self, *args):
        print(json.dumps(self.sent), flush=True)

    def __aiter__(self):
        return self

    async def __anext__(self):
        await self.reading.wait()
        if sys.argv[1] == "disconnect":
            raise StopAsyncIteration
        if sys.argv[1] == "error":
            raise RuntimeError("fixture gateway disconnected")
        await asyncio.Future()

    async def send(self, text):
        raw = text.encode("utf-8")
        self.sent.append({"bytes": len(raw), "digest": hashlib.sha256(raw).hexdigest()})


module("websockets.asyncio.client", connect=lambda *args, **kwargs: WebSocket())
`;

async function runBridge(
  script: string,
  input: Buffer,
  scenario = "eof",
  keepStdinOpen = false,
): Promise<{ code: number | null; sent: { bytes: number; digest: string }[]; stderr: string }> {
  if (!python) throw new Error("Python 3.9+ unavailable");
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  const child = spawn(
    python,
    ["-I", "-u", "-c", fixture + `\nexec(${JSON.stringify(script)}, {})`, scenario],
    {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
  child.stdin.on("error", () => undefined); // Oversize rejection may close the pipe mid-write.
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (keepStdinOpen) child.stdin.write(input);
    else child.stdin.end(input);
    const code = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Bridge did not exit: ${stderr}`)), 5000);
      }),
    ]);
    const summary: unknown = JSON.parse(stdout.trim() || "[]");
    expect(Array.isArray(summary)).toBe(true);
    return { code, sent: summary as { bytes: number; digest: string }[], stderr };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed.catch(() => undefined);
  }
}

// On non-Windows hosts this tests the Windows stdin branch, not IOCP itself.
const windowsScript = GATEWAY_LAUNCH.replace('if sys.platform == "win32":', "if True:");
describe.skipIf(!python)("Hermes bridge subprocess (requires Python 3.9+)", () => {
  it.each([
    ["disconnect", false],
    ["disconnect", true],
    ["error", false],
    ["error", true],
  ])(
    "exits on %s with partial stdin=%s and no EOF",
    async (scenario, partial) => {
      const result = await runBridge(
        windowsScript,
        Buffer.from(partial ? '{"partial":' : ""),
        scenario,
        true,
      );
      expect(result.code).toBe(scenario === "error" ? 1 : 0);
      expect(result.sent).toEqual([]);
      if (scenario === "error") expect(result.stderr).toContain("fixture gateway disconnected");
      else expect(result.stderr).toBe("");
    },
    10_000,
  );

  for (const [name, script] of [
    ["native", GATEWAY_LAUNCH],
    ["Windows stdin", windowsScript],
  ] as const) {
    describe(name, () => {
      it("exits cleanly on empty stdin EOF", async () => {
        expect(await runBridge(script, Buffer.alloc(0))).toEqual({ code: 0, sent: [], stderr: "" });
      });

      it("forwards complete lines without splitting UTF-8 or blank/CRLF input", async () => {
        const first = Buffer.from('{"text":"你好🙂"}');
        const invalid = Buffer.from('{"text":"�"}');
        const result = await runBridge(
          script,
          Buffer.concat([
            Buffer.from(`  ${first.toString()}  \r\n\n`),
            Buffer.from('{"text":"'),
            Buffer.from([255]),
            Buffer.from('"}\n'),
          ]),
        );
        expect(result).toEqual({
          code: 0,
          sent: [first, invalid].map((raw) => ({ bytes: raw.length, digest: digest(raw) })),
          stderr: "",
        });
      });

      it.each(["\n", ""])(
        "accepts exactly 8 MiB of content followed by %j",
        async (ending) => {
          const raw = Buffer.from('{"text":"' + "x".repeat(limit - 11) + '"}');
          expect(raw.length).toBe(limit);
          expect(await runBridge(script, Buffer.concat([raw, Buffer.from(ending)]))).toEqual({
            code: 0,
            sent: [{ bytes: limit, digest: digest(raw) }],
            stderr: "",
          });
        },
        10_000,
      );
    });
  }

  it("propagates a stdin read error instead of leaving the bridge waiting", async () => {
    const result = await runBridge(windowsScript, Buffer.alloc(0), "read-error", true);
    expect(result.code).toBe(1);
    expect(result.sent).toEqual([]);
    expect(result.stderr).toContain("fixture stdin read failed");
  });

  it("forwards successive lines through the bounded reader", async () => {
    const raw = Buffer.from('{"text":"next"}');
    const result = await runBridge(windowsScript, Buffer.from(`${raw.toString()}\n`.repeat(128)));
    expect(result).toEqual({
      code: 0,
      sent: Array.from({ length: 128 }, () => ({ bytes: raw.length, digest: digest(raw) })),
      stderr: "",
    });
  });

  it("rejects an oversized line without EOF or forwarding a fragment", async () => {
    const result = await runBridge(windowsScript, Buffer.alloc(limit + 1, "x"), "eof", true);
    expect(result.code).toBe(1);
    expect(result.sent).toEqual([]);
    expect(result.stderr).toContain("stdin line exceeds the 8 MiB bridge limit");
  }, 10_000);
});

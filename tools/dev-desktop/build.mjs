/** Quiet Web builds: live terminal progress and bounded failure diagnostics. */
import { spawn } from "node:child_process";
import { runBuildProcess } from "./build-process.mjs";

const buildStages = {
  "build:typescript": "TypeScript",
  "build:plugins": "Harness plugins",
  "build:rust": "Rust",
  "build:web:ui": "Web UI",
  pack: "Packaging",
};

export async function runQuietWebBuild(
  invocation,
  { root, environment, spawnImplementation = spawn, outputStream = process.stdout },
) {
  const startedAt = performance.now();
  const interactive = outputStream.isTTY === true;
  let stage = "";
  const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(2);
  const renderProgress = () => {
    outputStream.write(
      `\r\x1b[2Kcodexhost web: building…${stage ? ` ${stage}` : ""} (${elapsed()}s)`,
    );
  };
  if (interactive) renderProgress();
  else console.log("codexhost web: building…");
  const timer = interactive ? setInterval(renderProgress, 200) : undefined;
  timer?.unref();
  let output = "";
  let pendingLine = "";
  let result;
  try {
    const capture = (chunk) => {
      output = (output + String(chunk)).slice(-64_000);
    };
    result = await runBuildProcess(invocation, {
      root,
      environment,
      spawnImplementation,
      onStdout: (chunk) => {
        capture(chunk);
        const previousStage = stage;
        const lines = (pendingLine + String(chunk)).split(/\r?\n/u);
        pendingLine = lines.pop().slice(-4096);
        for (const line of lines) {
          const lifecycle =
            /^> \S+ (build:typescript|build:plugins|build:rust|build:web:ui|pack)(?:\s|$)/u.exec(
              line,
            );
          const plugins = /^codexhost web: client plugins (\d+\/\d+)$/u.exec(line);
          if (lifecycle) stage = buildStages[lifecycle[1]];
          if (plugins) stage = `Web UI plugins ${plugins[1]}`;
          if (line === "codexhost web: building browser shell") stage = "Browser shell";
        }
        if (interactive && stage !== previousStage) renderProgress();
      },
      onStderr: capture,
    });
  } finally {
    clearInterval(timer);
    if (interactive) outputStream.write("\r\x1b[2K");
  }
  if (result.code === 0) {
    console.log(`codexhost web: build complete (${elapsed()}s)\n`);
  } else {
    const reason = result.signal ? `signal ${result.signal}` : `status ${result.code ?? "unknown"}`;
    console.error(`codexhost web: build failed (${reason}, ${elapsed()}s)`);
    if (output) console.error(output.trimEnd());
    console.error("Run npm run build:web for the full build output.");
  }
  return result;
}

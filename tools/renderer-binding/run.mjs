import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CdpClient,
  getCdpBrowserVersion,
  inspectRendererDom,
  installRendererControlSession,
  waitForRendererTarget,
} from "../../packages/desktop-control/dist/index.js";
import { installRendererObserver, readRendererObserver } from "./renderer-observer.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const defaultOutputDirectory = path.join(repositoryRoot, ".codexhost", "renderer-binding");
export const RENDERER_PROBE_AGENTS = Object.freeze([
  "codex",
  "pi",
  "claude-code",
  "deepseek-harness",
  "grok",
  "gemini",
]);

function usage() {
  console.error(`usage:
  node tools/renderer-binding/run.mjs [--endpoint <loopback-url>]
    [--inspector-endpoint <loopback-url>] [--desktop <absolute-file>]
    [--observe-seconds <seconds>] [--until-submissions <count>]
    [--output <directory>] [--keep-desktop]

When --desktop is provided, the probe starts that executable with CDP and main-process Inspector
ports, then closes only the process tree it started. Without --desktop, it attaches to both existing
endpoints.`);
}

function parseInteger(value, option, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${option} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function parseArguments(arguments_) {
  const options = {
    endpoint: "http://127.0.0.1:9222",
    inspectorEndpoint: "http://127.0.0.1:9223",
    desktop: null,
    observeSeconds: 30,
    untilSubmissions: null,
    outputDirectory: defaultOutputDirectory,
    keepDesktop: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = () => {
      index += 1;
      if (index >= arguments_.length) throw new Error(`${argument} requires a value`);
      return arguments_[index];
    };
    switch (argument) {
      case "--endpoint":
        options.endpoint = value();
        break;
      case "--inspector-endpoint":
        options.inspectorEndpoint = value();
        break;
      case "--desktop":
        options.desktop = path.resolve(value());
        break;
      case "--observe-seconds":
        options.observeSeconds = parseInteger(value(), argument, 1, 3600);
        break;
      case "--until-submissions":
        options.untilSubmissions = parseInteger(value(), argument, 1, 20);
        break;
      case "--output":
        options.outputDirectory = path.resolve(value());
        break;
      case "--keep-desktop":
        options.keepDesktop = true;
        break;
      case "--enable-claude-code":
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateProbeStatus(value) {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Number.isInteger(value.mountedComposers) ||
    !Array.isArray(value.enabledAgents) ||
    value.enabledAgents.length < 2 ||
    value.enabledAgents.some((agent) => !RENDERER_PROBE_AGENTS.includes(agent)) ||
    !value.enabledAgents.includes("codex") ||
    !value.enabledAgents.includes("pi") ||
    !Array.isArray(value.selections) ||
    !isRecord(value.adapter) ||
    !["installing", "ready", "unsupported"].includes(value.adapter.state) ||
    !Number.isInteger(value.adapter.modelUpdates)
  ) {
    throw new Error("Renderer binding probe returned an invalid status");
  }
  for (const selection of value.selections) {
    if (
      !isRecord(selection) ||
      typeof selection.composerId !== "string" ||
      !RENDERER_PROBE_AGENTS.includes(selection.agent) ||
      !["draft", "locked"].includes(selection.phase)
    ) {
      throw new Error("Renderer binding probe returned an invalid selection");
    }
  }
  return value;
}

function endpointPort(endpoint, option) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`${option} must be a loopback HTTP URL`);
  }
  return url.port ? parseInteger(url.port, `${option} port`, 1, 65_535) : 80;
}

function launchDesktop(executable, cdpPort, inspectorPort) {
  if (!fs.statSync(executable).isFile()) {
    throw new Error(`Desktop executable is not a file: ${executable}`);
  }
  const child = spawn(
    executable,
    [`--remote-debugging-port=${cdpPort}`, `--inspect=${inspectorPort}`],
    {
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: false,
      env: process.env,
    },
  );
  child.unref();
  return child;
}

function stopDesktop(child) {
  if (!child || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") throw error;
  }
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeTargetUrl(value) {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  try {
    const url = new URL(value);
    return url.protocol === "app:" ? `${url.protocol}//${url.host}${url.pathname}` : url.protocol;
  } catch {
    return "unknown";
  }
}

async function inspectBrowserTargets(endpoint) {
  const version = await getCdpBrowserVersion(endpoint);
  const browserClient = await CdpClient.connect(version.webSocketDebuggerUrl);
  const attached = new Map();
  const removeListener = browserClient.on("Target.attachedToTarget", (params) => {
    if (
      isRecord(params) &&
      typeof params.sessionId === "string" &&
      isRecord(params.targetInfo) &&
      typeof params.targetInfo.targetId === "string" &&
      typeof params.targetInfo.type === "string"
    ) {
      attached.set(params.sessionId, params.targetInfo);
    }
  });
  try {
    await browserClient.command("Target.setDiscoverTargets", { discover: true });
    await browserClient.command("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await sleep(750);
    const response = await browserClient.command("Target.getTargets");
    if (!isRecord(response) || !Array.isArray(response.targetInfos)) {
      throw new Error("Target.getTargets returned an invalid result");
    }
    const targets = response.targetInfos.map((target) => {
      if (
        !isRecord(target) ||
        typeof target.targetId !== "string" ||
        typeof target.type !== "string"
      ) {
        throw new Error("Target.getTargets returned an invalid target");
      }
      return {
        targetId: target.targetId,
        type: target.type,
        attached: target.attached === true,
        url: safeTargetUrl(target.url),
      };
    });
    const attachedTargets = [];
    for (const [sessionId, target] of attached) {
      let runtime = { available: false, elementCount: null };
      try {
        const evaluation = await browserClient.sessionCommand(sessionId, "Runtime.evaluate", {
          expression: "({ elementCount: document.querySelectorAll('*').length })",
          returnByValue: true,
        });
        if (
          isRecord(evaluation) &&
          isRecord(evaluation.result) &&
          isRecord(evaluation.result.value) &&
          Number.isInteger(evaluation.result.value.elementCount)
        ) {
          runtime = { available: true, elementCount: evaluation.result.value.elementCount };
        }
      } catch {
        // Some non-page targets do not provide a DOM Runtime.
      }
      attachedTargets.push({
        targetId: target.targetId,
        type: target.type,
        url: safeTargetUrl(target.url),
        runtime,
      });
    }
    return {
      browser: version.browser,
      protocolVersion: version.protocolVersion,
      targets,
      attachedTargets,
    };
  } finally {
    removeListener();
    browserClient.close();
  }
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const probeBundlePath = path.join(
    repositoryRoot,
    "packages",
    "renderer-extension",
    "dist",
    "renderer-binding-probe.js",
  );
  if (!fs.existsSync(probeBundlePath)) {
    throw new Error("Renderer probe bundle is missing; run npm run build:renderer first");
  }
  fs.mkdirSync(options.outputDirectory, { recursive: true });

  let desktop = null;
  let pageClient = null;
  let rendererControl = null;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const cdpPort = endpointPort(options.endpoint, "--endpoint");
    const inspectorPort = endpointPort(options.inspectorEndpoint, "--inspector-endpoint");
    if (cdpPort === inspectorPort) throw new Error("CDP and Inspector ports must differ");
    if (options.desktop) {
      desktop = launchDesktop(options.desktop, cdpPort, inspectorPort);
    }

    const target = await waitForRendererTarget(options.endpoint, { timeoutMs: 30_000 });
    const browserTargets = await inspectBrowserTargets(options.endpoint);
    pageClient = await CdpClient.connect(target.webSocketDebuggerUrl);
    await pageClient.command("Runtime.enable");
    const cdpDom = await inspectRendererDom(pageClient);
    const source = fs.readFileSync(probeBundlePath, "utf8");
    const enabledAgents = [...RENDERER_PROBE_AGENTS];
    rendererControl = await installRendererControlSession({
      inspectorEndpoint: options.inspectorEndpoint,
      rendererSource: source,
      enabledAgents,
      timeoutMs: 60_000,
    });
    const {
      inventory: electronWebContents,
      renderer: selectedRenderer,
      titlePolicy,
      titlePolicyReadiness,
      draftPrewarmPolicy,
    } = rendererControl.snapshot;
    console.log(JSON.stringify({ type: "renderer-inventory", webContents: electronWebContents }));
    console.log(JSON.stringify({ type: "main-process-title-policy", ...titlePolicy }));
    console.log(JSON.stringify({ type: "renderer-title-policy", ...titlePolicyReadiness }));
    console.log(JSON.stringify({ type: "renderer-draft-prewarm-policy", ...draftPrewarmPolicy }));
    const executeInRenderer = (expression) => rendererControl.executeRenderer(expression);
    await installRendererObserver(executeInRenderer);

    const report = {
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      enabledDevelopmentHarnesses: [],
      target: {
        id: target.id,
        type: target.type,
        url: safeTargetUrl(target.url),
      },
      browserTargets,
      cdpDom,
      electronWebContents,
      selectedRendererId: selectedRenderer.id,
      titlePolicy,
      titlePolicyReadiness,
      draftPrewarmPolicy,
      titlePolicyCounters: null,
      status: null,
      observer: null,
      creationBinding: {
        status: "pending",
        rendererSubmissionObserved: false,
        creationBoundaryObserved: false,
        reason: "Waiting for the versioned Renderer Adapter status",
      },
    };
    let observedCount = 0;
    const deadline = Date.now() + options.observeSeconds * 1000;
    while (!interrupted && Date.now() < deadline) {
      const [status, observer] = await Promise.all([
        executeInRenderer("window.__codexhostRendererBindingProbeV1?.status() ?? null").then(
          validateProbeStatus,
        ),
        readRendererObserver(executeInRenderer),
      ]);
      report.status = status;
      report.observer = observer;
      report.creationBinding.status = status.adapter.state === "ready" ? "ready" : "blocked";
      report.creationBinding.reason =
        status.adapter.state === "ready"
          ? "Versioned Model-state, draft-prewarm, and title policies are ready"
          : `Renderer Adapter is ${status.adapter.state}: ${status.adapter.reason}`;
      report.creationBinding.rendererSubmissionObserved = observer.observations.length > 0;
      for (const observation of observer.observations.slice(observedCount)) {
        console.log(JSON.stringify({ type: "submission-observed", ...observation }));
      }
      observedCount = observer.observations.length;
      if (options.untilSubmissions !== null && observedCount >= options.untilSubmissions) break;
      await sleep(250);
    }

    report.titlePolicyCounters = await rendererControl.readTitlePolicyCounters();
    const reportPath = path.join(options.outputDirectory, "renderer-binding.local.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify({
        type: "probe-completed",
        mountedComposers: report.status?.mountedComposers ?? 0,
        observedSubmissions: report.observer?.observations.length ?? 0,
        creationBindingStatus: report.creationBinding.status,
        selectedRendererId: selectedRenderer.id,
        reportPath,
      }),
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    rendererControl?.close();
    pageClient?.close();
    if (desktop && !options.keepDesktop) stopDesktop(desktop);
    else desktop?.unref();
  }
}

const invokedAsScript =
  typeof process.argv[1] === "string" &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  try {
    await run();
  } catch (error) {
    console.error(
      `renderer binding probe: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

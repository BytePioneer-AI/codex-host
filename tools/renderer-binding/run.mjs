import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CdpClient,
  getCdpBrowserVersion,
  inspectRendererDom,
  installMainProcessTitlePolicy,
  installRendererDraftPrewarmPolicy,
  listCdpTargets,
  markRendererTitlePolicyReady,
  readMainProcessTitlePolicyCounters,
  waitForRendererTarget,
} from "../../packages/desktop-control/dist/index.js";
import {
  selectRendererWebContents,
  waitForRendererTitlePolicyReady,
} from "./renderer-selection.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const defaultOutputDirectory = path.join(repositoryRoot, ".codexhost", "renderer-binding");

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

function validateProbeStatus(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isInteger(value.mountedComposers) ||
    !Number.isInteger(value.switchingComposers) ||
    !isRecord(value.switchCounters) ||
    !Number.isInteger(value.switchCounters.attempts) ||
    !Number.isInteger(value.switchCounters.committed) ||
    !Number.isInteger(value.switchCounters.rejected) ||
    value.switchCounters.committed + value.switchCounters.rejected >
      value.switchCounters.attempts ||
    !Array.isArray(value.selections) ||
    !Array.isArray(value.observations) ||
    !isRecord(value.adapter) ||
    !["installing", "ready", "unsupported"].includes(value.adapter.state) ||
    !Number.isInteger(value.adapter.decoratedRequests) ||
    !Number.isInteger(value.adapter.modelUpdates) ||
    !Number.isInteger(value.adapter.candidateCount) ||
    !isRecord(value.diagnostics) ||
    !Number.isInteger(value.diagnostics.editorCandidates) ||
    !Number.isInteger(value.diagnostics.replacementTransfers) ||
    !Array.isArray(value.diagnostics.shapes)
  ) {
    throw new Error("Renderer binding probe returned an invalid status");
  }
  for (const selection of value.selections) {
    if (
      !isRecord(selection) ||
      typeof selection.composerId !== "string" ||
      !["codex", "pi"].includes(selection.agent) ||
      !["draft", "locked"].includes(selection.phase)
    ) {
      throw new Error("Renderer binding probe returned an invalid selection");
    }
  }
  for (const observation of value.observations) {
    if (
      !isRecord(observation) ||
      typeof observation.submissionId !== "string" ||
      typeof observation.composerId !== "string" ||
      !["codex", "pi"].includes(observation.agent) ||
      !["click", "enter", "submit"].includes(observation.trigger) ||
      typeof observation.capturedAt !== "string"
    ) {
      throw new Error("Renderer binding probe returned an invalid observation");
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
  return spawn(executable, [`--remote-debugging-port=${cdpPort}`, `--inspect=${inspectorPort}`], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: false,
  });
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

async function waitForInspectorTarget(endpoint, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const target = (await listCdpTargets(endpoint)).find(
        (candidate) => candidate.type === "node",
      );
      if (target) return target;
      lastError = new Error("Inspector has no Node target");
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Electron main-process Inspector did not become ready${detail}`);
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

const electronModuleExpression = `(() => {
  const mainModule = process.mainModule;
  if (mainModule != null && typeof mainModule.require === 'function') {
    return mainModule.require('electron');
  }
  const { createRequire } = process.getBuiltinModule('module');
  return createRequire(process.execPath)('electron');
})()`;

const webContentsRuntimeExpression = `(() => ({
  elementCount: document.querySelectorAll('*').length,
  editorCandidates: document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]').length,
  sendButtonCandidates: [...document.querySelectorAll('button')].filter((button) => button.type === 'submit').length
}))()`;

async function inspectElectronWebContents(inspector) {
  const expression = `(async () => {
    const { webContents } = ${electronModuleExpression};
    const result = [];
    for (const contents of webContents.getAllWebContents()) {
      let runtime = { available: false, elementCount: null, editorCandidates: null, sendButtonCandidates: null };
      try {
        const evaluation = contents.executeJavaScript(${JSON.stringify(webContentsRuntimeExpression)}, true);
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Renderer inspection timed out')), 2_000);
        });
        runtime = { available: true, ...(await Promise.race([evaluation, timeout])) };
      } catch {}
      result.push({
        id: contents.id,
        type: contents.getType(),
        surface: contents.getURL().includes('avatar-overlay') ? 'overlay' : 'primary',
        url: contents.getURL(),
        runtime,
      });
    }
    return result;
  })()`;
  const value = await inspector.evaluate(expression);
  if (!Array.isArray(value)) throw new Error("Electron webContents inspection returned an array");
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !Number.isInteger(item.id) ||
      typeof item.type !== "string" ||
      !["primary", "overlay"].includes(item.surface) ||
      !isRecord(item.runtime)
    ) {
      throw new Error("Electron webContents inspection returned an invalid item");
    }
    return {
      id: item.id,
      type: item.type,
      surface: item.surface,
      url: safeTargetUrl(item.url),
      runtime: {
        available: item.runtime.available === true,
        elementCount: Number.isInteger(item.runtime.elementCount)
          ? item.runtime.elementCount
          : null,
        editorCandidates: Number.isInteger(item.runtime.editorCandidates)
          ? item.runtime.editorCandidates
          : null,
        sendButtonCandidates: Number.isInteger(item.runtime.sendButtonCandidates)
          ? item.runtime.sendButtonCandidates
          : null,
      },
    };
  });
}

async function waitForElectronRenderer(inspector, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastContents = [];
  while (Date.now() < deadline) {
    lastContents = await inspectElectronWebContents(inspector);
    const selected = selectRendererWebContents(lastContents);
    if (selected) return { contents: lastContents, selected };
    await sleep(250);
  }
  console.log(JSON.stringify({ type: "renderer-inventory", webContents: lastContents }));
  throw new Error("Inspector did not find a populated Electron Renderer webContents");
}

async function executeInWebContents(inspector, webContentsId, source) {
  return inspector.evaluate(`(async () => {
    const { webContents } = ${electronModuleExpression};
    const contents = webContents.fromId(${webContentsId});
    if (contents == null || contents.isDestroyed()) throw new Error('Renderer webContents is unavailable');
    const result = await contents.executeJavaScript(${JSON.stringify(source)}, true);
    return result === undefined ? null : result;
  })()`);
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
  let inspectorClient = null;
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
    if (options.desktop) desktop = launchDesktop(options.desktop, cdpPort, inspectorPort);

    const [target, inspectorTarget] = await Promise.all([
      waitForRendererTarget(options.endpoint, { timeoutMs: 30_000 }),
      waitForInspectorTarget(options.inspectorEndpoint),
    ]);
    const browserTargets = await inspectBrowserTargets(options.endpoint);
    pageClient = await CdpClient.connect(target.webSocketDebuggerUrl);
    inspectorClient = await CdpClient.connect(inspectorTarget.webSocketDebuggerUrl);
    await pageClient.command("Runtime.enable");
    const cdpDom = await inspectRendererDom(pageClient);
    const rendererResult = await waitForElectronRenderer(inspectorClient);
    const electronWebContents = rendererResult.contents;
    let selectedRenderer = rendererResult.selected;
    console.log(JSON.stringify({ type: "renderer-inventory", webContents: electronWebContents }));
    const titlePolicy = await installMainProcessTitlePolicy(inspectorClient);
    console.log(JSON.stringify({ type: "main-process-title-policy", ...titlePolicy }));
    await inspectorClient.evaluate(`(() => {
      const { webContents } = ${electronModuleExpression};
      const contents = webContents.fromId(${selectedRenderer.id});
      if (contents == null || contents.isDestroyed()) throw new Error('Renderer webContents is unavailable');
      contents.reload();
      return null;
    })()`);
    await sleep(750);
    selectedRenderer = (await waitForElectronRenderer(inspectorClient)).selected;
    const titlePolicyReadiness = await waitForRendererTitlePolicyReady(() =>
      markRendererTitlePolicyReady(inspectorClient),
    );
    console.log(JSON.stringify({ type: "renderer-title-policy", ...titlePolicyReadiness }));
    const draftPrewarmPolicy = await installRendererDraftPrewarmPolicy(
      inspectorClient,
      selectedRenderer.id,
    );
    console.log(JSON.stringify({ type: "renderer-draft-prewarm-policy", ...draftPrewarmPolicy }));
    const source = fs.readFileSync(probeBundlePath, "utf8");
    await executeInWebContents(inspectorClient, selectedRenderer.id, source);

    const report = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
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
      const status = validateProbeStatus(
        await executeInWebContents(
          inspectorClient,
          selectedRenderer.id,
          "window.__codexhostRendererBindingProbeV1?.status() ?? null",
        ),
      );
      report.status = status;
      report.creationBinding.status = status.adapter.state === "ready" ? "ready" : "blocked";
      report.creationBinding.reason =
        status.adapter.state === "ready"
          ? "Versioned Model-state, draft-prewarm, and title policies are ready"
          : `Renderer Adapter is ${status.adapter.state}: ${status.adapter.reason}`;
      report.creationBinding.rendererSubmissionObserved = status.observations.length > 0;
      for (const observation of status.observations.slice(observedCount)) {
        console.log(JSON.stringify({ type: "submission-observed", ...observation }));
      }
      observedCount = status.observations.length;
      if (options.untilSubmissions !== null && observedCount >= options.untilSubmissions) break;
      await sleep(250);
    }

    report.titlePolicyCounters = await readMainProcessTitlePolicyCounters(inspectorClient);
    const reportPath = path.join(options.outputDirectory, "renderer-binding.local.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify({
        type: "probe-completed",
        mountedComposers: report.status?.mountedComposers ?? 0,
        observedSubmissions: report.status?.observations.length ?? 0,
        creationBindingStatus: report.creationBinding.status,
        selectedRendererId: selectedRenderer.id,
        reportPath,
      }),
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    inspectorClient?.close();
    pageClient?.close();
    if (desktop && !options.keepDesktop) stopDesktop(desktop);
    else desktop?.unref();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    `renderer binding probe: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

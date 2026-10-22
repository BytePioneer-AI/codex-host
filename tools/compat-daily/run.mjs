#!/usr/bin/env node
/**
 * Compact ChatGPT/Codex Desktop pin check. Fetches the public Sparkle appcast
 * and compares it to Renderer voice pins. Does not download the .app zip.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPCAST_URL = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function capture(source, pattern, label) {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`Missing ${label}`);
  return match[1];
}

function optionalCapture(source, pattern) {
  return source.match(pattern)?.[1];
}

export function readPins(files) {
  const work = files.clientOwned;
  const chat = files.nativeChat;
  const start = files.voiceStart ?? "";
  const workVersion = capture(work, /CLIENT_OWNED_VOICE_VERSION = "([^"]+)"/u, "work version");
  const workInitial = capture(
    work,
    /CLIENT_OWNED_VOICE_INITIAL_ASSET = "([^"]+)"/u,
    "work initial",
  );
  return {
    workVersion,
    workInitial,
    workShared: capture(work, /CLIENT_OWNED_VOICE_SHARED_ASSET = "([^"]+)"/u, "work shared"),
    overlayAsset: optionalCapture(start, /VOICE_START_OVERLAY_ASSET = "([^"]+)"/u),
    chatVersion: optionalCapture(chat, /NATIVE_CHAT_VOICE_VERSION = "([^"]+)"/u) ?? workVersion,
    chatInitial: optionalCapture(chat, /NATIVE_CHAT_INITIAL_ASSET = "([^"]+)"/u) ?? workInitial,
    chatStart: capture(chat, /START_ASSET = "([^"]+)"/u, "chat start"),
  };
}

export function parseAppcast(xml) {
  const item = xml.match(/<item>[\s\S]*?<\/item>/u)?.[0];
  if (!item) throw new Error("Appcast has no item");
  const version = item.match(
    /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/u,
  )?.[1];
  const build = item.match(/<sparkle:version>([^<]+)<\/sparkle:version>/u)?.[1];
  if (!version || !build) throw new Error("Appcast item missing version");
  return { version, build };
}

export function evaluate(pins, latest) {
  const findings = [];
  if (latest.version !== pins.workVersion) {
    findings.push({
      surface: "work-voice",
      title: `compat-daily/work-voice: pin ${pins.workVersion} behind desktop ${latest.version}`,
      detail: `Work/gateway voice is pinned to ${pins.workVersion} (${pins.workInitial}${pins.overlayAsset ? `, overlay ${pins.overlayAsset}` : ""}). Sparkle latest is ${latest.version} build ${latest.build}.`,
    });
  }
  if (latest.version !== pins.chatVersion) {
    findings.push({
      surface: "chat-voice",
      title: `compat-daily/chat-voice: pin ${pins.chatVersion} behind desktop ${latest.version}`,
      detail: `ChatGPT Chat voice is pinned to ${pins.chatVersion} (${pins.chatInitial}, ${pins.chatStart}). Sparkle latest is ${latest.version} build ${latest.build}. Native Chat start/prewarm on this Desktop is unqualified.`,
    });
  }
  return { latest, pins, findings };
}

/** Matching pins clear version drift, independently of live voice acceptance. */
export function recoveredPinIssues(report, issues) {
  return issues.flatMap((issue) => {
    const match = /^compat-daily\/(chat-voice|work-voice): pin \S+ behind desktop (\S+)$/u.exec(
      issue.title,
    );
    if (!match || issue.pull_request) return [];
    const surface = match[1];
    const pin = surface === "chat-voice" ? report.pins.chatVersion : report.pins.workVersion;
    return pin === report.latest.version || pin === match[2]
      ? [{ number: issue.number, surface, version: pin }]
      : [];
  });
}

export async function loadPinsFromRepo(root = ROOT) {
  const overlay = path.join(
    root,
    "packages/renderer-extension/src/renderer-voice-start-capability.ts",
  );
  const [clientOwned, nativeChat, voiceStart] = await Promise.all([
    readFile(
      path.join(root, "packages/renderer-extension/src/renderer-client-owned-voice.ts"),
      "utf8",
    ),
    readFile(
      path.join(root, "packages/renderer-extension/src/renderer-native-chat-voice.ts"),
      "utf8",
    ),
    readFile(overlay, "utf8").catch(() => ""),
  ]);
  return readPins({ clientOwned, nativeChat, voiceStart });
}

export async function fetchAppcast(fetchImpl = fetch, url = APPCAST_URL) {
  const response = await fetchImpl(url, { headers: { accept: "application/xml,text/xml,*/*" } });
  if (!response.ok) throw new Error(`Appcast HTTP ${response.status}`);
  return parseAppcast(await response.text());
}

async function main() {
  const pins = await loadPinsFromRepo();
  const latest = await fetchAppcast();
  const report = evaluate(pins, latest);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.findings.length > 0) process.exitCode = 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

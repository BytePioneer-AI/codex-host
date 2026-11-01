import os from "node:os";
import path from "node:path";

import type {
  HarnessUsageEntry,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import {
  jsonlRecords,
  jsonlUsageSources,
  nativeTimeMs,
  parseHarnessUsageEntry,
  usageSessionTitle,
  withUsageSession,
} from "@codexhost/harness-adapter/usage-statistics";

import type { QoderVariant } from "./qoder-runtime.js";
import { readQoderModelLabels } from "./qoder-model-labels.js";

/** Match the selected distribution's native SDK history root, without calling the SDK. */
export function qoderProjectsDirectory(
  environment: NodeJS.ProcessEnv,
  variant: QoderVariant,
): string {
  const cn = variant === "cn";
  const config = environment[cn ? "QODERCN_CONFIG_DIR" : "QODER_CONFIG_DIR"];
  const home =
    environment[cn ? "QODERCN_CLI_HOME" : "QODER_CLI_HOME"] ||
    environment.HOME ||
    environment.USERPROFILE ||
    os.homedir();
  return path.resolve(config || path.join(home, cn ? ".qoder-cn" : ".qoder"), "projects");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function qoderUserText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join(" ");
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Qoder persists Anthropic-shaped message usage; input excludes cache and output includes
 * thinking. Content blocks share message.id and only the final block may carry usage.
 * Read all branches and subagents, not just the SDK's currently active conversation view.
 */
export async function readQoderUsage(
  file: string,
  signal: AbortSignal,
): Promise<HarnessUsageEntry[]> {
  const messages = new Map<string, { at: number | null; entry?: HarnessUsageEntry }>();
  let sessionId: unknown;
  let cwd: unknown;
  let customTitle: string | undefined;
  let summary: string | undefined;
  let firstPrompt: string | undefined;
  for await (const line of jsonlRecords(file, '"type"', signal)) {
    signal.throwIfAborted();
    if (line.type === "custom-title") customTitle = usageSessionTitle(line.customTitle);
    else if (!summary && line.type === "summary") summary = usageSessionTitle(line.summary);
    else if (!firstPrompt && line.type === "user") {
      firstPrompt = usageSessionTitle(qoderUserText(line.message));
    }
    if (line.type !== "assistant" || !isRecord(line.message)) continue;
    sessionId ??= line.sessionId;
    cwd ??= line.cwd;
    // Native SDK forks regenerate row UUIDs and can redate the last copied row. Count the
    // original request only, rather than moving its usage to the fork's creation date.
    if (isRecord(line.forkedFrom) || line.isApiErrorMessage === true) continue;
    const { id, model, usage } = line.message;
    if (typeof id !== "string" || !id || model === "<synthetic>") continue;
    const message = messages.get(id) ?? { at: null };
    message.at ??= nativeTimeMs(line.timestamp);
    messages.set(id, message);
    if (!isRecord(usage) || message.at === null) continue;
    const input = usage.input_tokens;
    const output = usage.output_tokens;
    const cached = usage.cache_read_input_tokens;
    const written = usage.cache_creation_input_tokens;
    // Do not turn missing cache buckets into zero: input_tokens alone is not total input.
    if (!count(input) || !count(output) || !count(cached) || !count(written)) continue;
    const split = isRecord(usage.cache_creation) ? usage.cache_creation : null;
    const oneHour = split?.ephemeral_1h_input_tokens;
    const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
    const thinking = details?.thinking_tokens;
    // Qoder records some requests with every token bucket at zero and only its credits: a real
    // model request always has input, so these counts were not reported, not zero.
    const unreported = input === 0 && output === 0 && cached === 0 && written === 0;
    const entry = parseHarnessUsageEntry({
      id,
      occurredAtMs: message.at,
      ...(typeof model === "string" && model ? { model } : {}),
      inputTokens: input + cached + written,
      cachedInputTokens: cached,
      cacheWriteInputTokens: written,
      ...(count(oneHour) ? { cacheWrite1hInputTokens: oneHour } : {}),
      outputTokens: output,
      ...(typeof usage.credits === "number" && Number.isFinite(usage.credits) && usage.credits >= 0
        ? { credits: usage.credits }
        : {}),
      ...(count(thinking) ? { reasoningOutputTokens: thinking } : {}),
      ...(unreported ? { tokensUnknown: true } : {}),
    });
    if (entry) message.entry = entry;
  }
  const session = {
    sessionId: typeof sessionId === "string" ? sessionId : undefined,
    cwd: typeof cwd === "string" ? cwd : undefined,
    title: customTitle ?? summary ?? firstPrompt,
  };
  return [...messages.values()].flatMap(({ entry }) =>
    entry ? [withUsageSession(entry, session)] : [],
  );
}

export function createQoderUsageStatistics(
  environment: NodeJS.ProcessEnv,
  variant: QoderVariant,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    readModelLabels: (signal: AbortSignal) =>
      readQoderModelLabels(path.dirname(qoderProjectsDirectory(environment, variant)), signal),
    listSources: (signal: AbortSignal) =>
      jsonlUsageSources(qoderProjectsDirectory(environment, variant), 4, signal),
    readSource: readQoderUsage,
  });
}

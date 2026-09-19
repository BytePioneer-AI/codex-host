import { execFile } from "node:child_process";
import path from "node:path";
import { modelRef } from "@codexhost/adapter-codebuddy";
import type { HarnessModelCatalog } from "@codexhost/harness-adapter";
import {
  HARNESS_MODEL_LABEL_MAX_LENGTH,
  harnessModelCatalogSchema,
} from "@codexhost/shared-contracts";
import { WORKBUDDY_DISABLE_PRODUCT_CACHE_ENV } from "./command.js";

const MAX_PRODUCT_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const PRODUCT_SNAPSHOT_READ_TIMEOUT_MS = 3_000;
const PRODUCT_CONFIG_PATH_ENV = "ACC_PRODUCT_CONFIG_PATH";
const PRODUCT_CONFIG_INLINE_ENVS = [
  "ACC_PRODUCT_CONFIG_V3",
  "ACC_PRODUCT_CONFIG_V2",
  "ACC_PRODUCT_CONFIG",
] as const;
const LAUNCHER_EXECUTABLE_ENV = "CODEXHOST_LAUNCHER_EXECUTABLE";
const READ_PROCESS_ENVIRONMENT_ARGUMENT = "--codexhost-read-process-environment";
const LIVE_PRODUCT_CONFIG_ENV = "ACC_PRODUCT_CONFIG_V3";
const WORKBUDDY_DAEMON_COMMAND = "app.asar\\main\\daemon-app-server-entry.js";

export interface WorkBuddyProductModel {
  id: string;
  name: string;
  credits?: string;
}

export interface WorkBuddyLiveProductSnapshot {
  serialized: string;
  models: WorkBuddyProductModel[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  return normalized || undefined;
}

export function parseWorkBuddyProductModels(value: unknown): WorkBuddyProductModel[] {
  const product = record(value);
  const models = product.models;
  const agents = product.agents;
  if (!Array.isArray(models) || !Array.isArray(agents)) return [];
  const cli = agents.map(record).find((agent) => nonBlank(agent.name) === "cli");
  if (!Array.isArray(cli?.models)) return [];
  const configuredIds = new Set(cli.models.map(nonBlank).filter((id): id is string => !!id));
  const parsed: WorkBuddyProductModel[] = [];
  const ids = new Set<string>();
  for (const value of models) {
    const source = record(value);
    const id = nonBlank(source.id);
    const name = nonBlank(source.name);
    if (!id || !name || !configuredIds.has(id) || ids.has(id)) continue;
    try {
      modelRef(id);
    } catch {
      continue;
    }
    ids.add(id);
    if (name.length > HARNESS_MODEL_LABEL_MAX_LENGTH) continue;
    const credits = nonBlank(source.credits);
    parsed.push({
      id,
      name,
      ...(credits && credits.length <= 64 ? { credits } : {}),
    });
  }
  return parsed;
}

export function sanitizeWorkBuddyProductEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized[PRODUCT_CONFIG_PATH_ENV];
  for (const name of PRODUCT_CONFIG_INLINE_ENVS) delete sanitized[name];
  sanitized[WORKBUDDY_DISABLE_PRODUCT_CACHE_ENV] = "1";
  return sanitized;
}

function readProcessEnvironment(
  launcher: string,
  desktopExecutable: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      launcher,
      [
        READ_PROCESS_ENVIRONMENT_ARGUMENT,
        "--executable",
        desktopExecutable,
        "--command-line-contains",
        WORKBUDDY_DAEMON_COMMAND,
        "--name",
        LIVE_PRODUCT_CONFIG_ENV,
      ],
      {
        encoding: "utf8",
        maxBuffer: MAX_PRODUCT_SNAPSHOT_BYTES + 1,
        timeout: PRODUCT_SNAPSHOT_READ_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error || typeof stdout !== "string" || stdout.length === 0) {
          resolve(undefined);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Reads the live App-owned snapshot without writing or logging its sensitive contents. */
export async function loadWorkBuddyLiveProductSnapshot(
  environment: NodeJS.ProcessEnv,
  desktopExecutable: string,
  read: (
    launcher: string,
    executable: string,
  ) => Promise<string | undefined> = readProcessEnvironment,
): Promise<WorkBuddyLiveProductSnapshot | undefined> {
  const launcher = nonBlank(environment[LAUNCHER_EXECUTABLE_ENV]);
  if (!launcher || !path.win32.isAbsolute(launcher) || !path.win32.isAbsolute(desktopExecutable))
    return;
  const serialized = await read(launcher, desktopExecutable).catch(() => undefined);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_PRODUCT_SNAPSHOT_BYTES) return;
  try {
    const value: unknown = JSON.parse(serialized);
    return { serialized, models: parseWorkBuddyProductModels(value) };
  } catch {
    return;
  }
}

function normalizedLabel(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** Native ACP Models stay first; live product duplicates are removed by ID and display label. */
export function mergeWorkBuddyProductModels(
  catalog: HarnessModelCatalog,
  productModels: readonly WorkBuddyProductModel[],
): HarnessModelCatalog {
  const refs = new Set(catalog.models.map((model) => model.ref.id));
  const labels = new Set(catalog.models.map((model) => normalizedLabel(model.label)));
  const models = [...catalog.models];
  for (const productModel of productModels) {
    const ref = modelRef(productModel.id);
    const labelKey = normalizedLabel(productModel.name);
    if (refs.has(ref.id) || labels.has(labelKey)) continue;
    refs.add(ref.id);
    labels.add(labelKey);
    const creditLabel = productModel.credits?.replace(/^x/iu, "").replace(/\s*credits$/iu, "x");
    const annotatedLabel = creditLabel
      ? `${productModel.name} · ${creditLabel}`
      : productModel.name;
    models.push({
      ref,
      label:
        annotatedLabel.length <= HARNESS_MODEL_LABEL_MAX_LENGTH
          ? annotatedLabel
          : productModel.name,
    });
  }
  return harnessModelCatalogSchema.parse({ ...catalog, models });
}

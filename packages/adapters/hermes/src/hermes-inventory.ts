import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessModelRef } from "@codexhost/shared-contracts";

import { decodeHermesModelRefId, encodeHermesModelRef } from "./hermes-models.js";

/**
 * The `hermes` launcher is a bash shim that execs the agent repository's
 * virtualenv interpreter:
 *   #!/usr/bin/env bash
 *   exec "<agentDir>/venv/bin/python" "<agentDir>/hermes" "$@"
 * The model inventory lives inside that virtualenv (hermes_cli.inventory), so
 * the same interpreter runs a read-only one-shot probe.
 */
const VENV_PYTHON_SHIM_PATTERN = /exec\s+"([^"]+?venv\/bin\/python)"/;

const INVENTORY_PROBE_SCRIPT = `
import json
from hermes_cli.inventory import build_models_payload, load_picker_context
context = load_picker_context()
payload = build_models_payload(
    context,
    explicit_only=True,
    include_unconfigured=False,
    picker_hints=False,
    canonical_order=True,
    pricing=False,
    capabilities=False,
    refresh=False,
    probe_custom_providers=False,
    probe_current_custom_provider=False,
    max_models=64,
)
rows = []
for row in payload.get("providers") or []:
    slug = str(row.get("slug") or "").strip()
    provider = str(row.get("name") or "").strip() or slug
    for entry in row.get("models") or []:
        model_id = (
            str(entry.get("id") or entry.get("model") or entry.get("name") or "").strip()
            if isinstance(entry, dict)
            else str(entry).strip()
        )
        if slug and model_id:
            rows.append({"modelId": slug + ":" + model_id, "label": model_id, "provider": provider})
current_provider = str(getattr(context, "current_provider", "") or "").strip()
current_model = str(getattr(context, "current_model", "") or "").strip()
current_model_id = current_provider + ":" + current_model if current_provider and current_model else None
print(json.dumps({"models": rows, "currentModelId": current_model_id}))
`;

export interface HermesInventoryModel {
  /** Native Hermes choice id, e.g. `zai:glm-5-turbo`. */
  modelId: string;
  label: string;
  provider: string;
}

export interface HermesInventory {
  models: HermesInventoryModel[];
  /** Native id of the configured default model, when discoverable. */
  currentModelId: string | null;
}

export class HermesInventoryError extends Error {}

async function venvPythonFromShim(hermesExecutable: string): Promise<string | null> {
  try {
    const shim = await readFile(hermesExecutable, "utf8");
    const match = VENV_PYTHON_SHIM_PATTERN.exec(shim);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function fallbackVenvPython(hermesExecutable: string): string {
  const agentDir = path.resolve(path.dirname(hermesExecutable), "../../.hermes/hermes-agent");
  return path.join(agentDir, "venv/bin/python");
}

function runProbe(pythonExecutable: string, timeoutMs: number): Promise<HermesInventory> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, ["-c", INVENTORY_PROBE_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HermesInventoryError("Hermes model inventory probe timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new HermesInventoryError(`Hermes inventory probe failed to start: ${String(error)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new HermesInventoryError(
            `Hermes inventory probe exited with ${code}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as {
          models?: HermesInventoryModel[];
          currentModelId?: unknown;
        };
        const models = (parsed.models ?? []).filter(
          (model) => typeof model?.modelId === "string" && model.modelId.length > 0,
        );
        resolve({
          models,
          currentModelId:
            typeof parsed.currentModelId === "string" && parsed.currentModelId.length > 0
              ? parsed.currentModelId
              : null,
        });
      } catch {
        reject(new HermesInventoryError("Hermes inventory probe returned malformed output"));
      }
    });
  });
}

/**
 * Resolve the virtualenv interpreter behind the `hermes` launcher and read the
 * real model inventory (same substrate as `hermes model`). Read-only: no
 * Session is created and no config is written.
 */
export async function readHermesModelInventory(
  hermesExecutable: string,
  timeoutMs = 20_000,
): Promise<HermesInventory> {
  const pythonExecutable =
    (await venvPythonFromShim(hermesExecutable)) ?? fallbackVenvPython(hermesExecutable);
  return runProbe(pythonExecutable, timeoutMs);
}

export interface HermesCatalogModel {
  ref: HarnessModelRef;
  label: string;
  description?: string;
}

/** Encode inventory rows into transport-safe catalog models (base64url refs). */
export function catalogModelsFromInventory(inventory: HermesInventory): {
  models: HermesCatalogModel[];
  defaultModel: HarnessModelRef | null;
} {
  const models: HermesCatalogModel[] = [];
  let defaultModel: HarnessModelRef | null = null;
  for (const model of inventory.models) {
    const ref = encodeHermesModelRef(model.modelId);
    if (!ref) continue;
    if (inventory.currentModelId && model.modelId === inventory.currentModelId) {
      defaultModel = ref;
    }
    models.push({
      ref,
      label: `${model.provider} / ${model.label}`,
      description: `Provider: ${model.provider}`,
    });
  }
  return { models, defaultModel };
}

/** Best-effort native model id for a transport-safe ref (labels never round-trip). */
export function nativeModelIdFromRefId(refId: string): string | null {
  return decodeHermesModelRefId(refId);
}

export const hermesInventoryPathsForTests = {
  os,
  path,
};

import { record, TraeError } from "./errors.js";

export interface Application {
  name: string;
  version: string;
  root: string;
  executable: string;
}
export interface Endpoint {
  protocolVersion: 1;
  instanceId: string;
  pid: number;
  port: number;
  token: string;
  application: Application;
  workspaceFolders: string[];
}
export interface BridgeModel {
  id: string;
  label: string;
  provider: string;
  multimodal: boolean;
}
export interface BridgeInspection {
  instanceId: string;
  application: Application;
  workspaceFolders: string[];
  agentType: string;
  models: BridgeModel[];
}
export interface BridgeEvent {
  event: string;
  id?: string;
  payload?: unknown;
}

export function readApplication(value: unknown): Application {
  if (
    !record(value) ||
    value.name !== "Trae CN" ||
    typeof value.version !== "string" ||
    typeof value.root !== "string" ||
    typeof value.executable !== "string"
  )
    throw new TraeError("protocolError", "The bridge is not a TRAE CN Desktop application");
  return {
    name: value.name,
    version: value.version,
    root: value.root,
    executable: value.executable,
  };
}

export function readEndpoint(value: unknown): Endpoint {
  if (
    !record(value) ||
    value.protocolVersion !== 1 ||
    typeof value.instanceId !== "string" ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !Number.isSafeInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65535 ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    !Array.isArray(value.workspaceFolders) ||
    !value.workspaceFolders.every((item) => typeof item === "string")
  )
    throw new TraeError("protocolError", "Invalid TRAE CN Companion metadata");
  return {
    protocolVersion: 1,
    instanceId: value.instanceId,
    pid: value.pid as number,
    port: value.port as number,
    token: value.token,
    application: readApplication(value.application),
    workspaceFolders: value.workspaceFolders as string[],
  };
}

export function readInspection(value: unknown): BridgeInspection {
  if (
    !record(value) ||
    typeof value.instanceId !== "string" ||
    typeof value.agentType !== "string" ||
    !Array.isArray(value.workspaceFolders) ||
    !value.workspaceFolders.every((item) => typeof item === "string") ||
    !Array.isArray(value.models)
  )
    throw new TraeError("protocolError", "Invalid TRAE CN inspection");
  const models = value.models.map((model): BridgeModel => {
    if (
      !record(model) ||
      typeof model.id !== "string" ||
      !model.id ||
      model.id.length > 512 ||
      typeof model.label !== "string" ||
      !model.label ||
      model.label.length > 256 ||
      typeof model.provider !== "string" ||
      typeof model.multimodal !== "boolean"
    )
      throw new TraeError("protocolError", "Invalid TRAE CN conversation model");
    return {
      id: model.id,
      label: model.label,
      provider: model.provider,
      multimodal: model.multimodal,
    };
  });
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new TraeError("protocolError", "Duplicate TRAE CN model identities");
  return {
    instanceId: value.instanceId,
    agentType: value.agentType,
    application: readApplication(value.application),
    workspaceFolders: value.workspaceFolders as string[],
    models,
  };
}

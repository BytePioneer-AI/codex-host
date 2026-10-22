import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  lstatSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  HarnessCredentialImports,
  HarnessCredentialTransfer,
} from "@codexhost/harness-adapter";
import {
  credentialImportNameSchema,
  credentialImportRecordSchema,
  type CredentialImportRecord,
  type CredentialOtherLogin,
} from "@codexhost/shared-contracts";
import { resolvePiExecutable } from "./command.js";

type LockBackend = {
  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T;
};
export interface PiCredentialInstallation {
  backend: LockBackend;
  providerModules: Record<"openai-codex" | "xai", string>;
  reservedNames: string[];
  configuredProviderNames?(): Promise<string[]>;
}
interface RecordFile {
  version: 1;
  owner: string;
  record: CredentialImportRecord;
  extension: string;
}
const PREFIX = "codexhost-account-";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseAuth(raw: string | undefined): Record<string, unknown> {
  const value: unknown = JSON.parse(raw ?? "{}");
  if (!object(value)) throw new Error("Invalid Pi auth store");
  return value;
}
/**
 * What an OAuth credential in Pi actually is, read from its access token's own claims. Issuer plus
 * client id are the same pair the Codex and Grok exporters verify, so a credential is only labelled
 * when it is the kind codexhost already understands, whatever the user named the Pi entry. The
 * token itself never leaves this function.
 */
const OAUTH_VENDORS = [
  {
    issuer: "https://auth.openai.com",
    client: "app_EMoamEEZ73f0CkXaXp7hrann",
    vendor: "openai-codex",
  },
  { issuer: "https://auth.x.ai", client: "b1a00492-073a-47ea-816f-4c329264a828", vendor: "xai" },
] as const;
function describeOauth(credential: unknown): { label?: string; vendor?: "openai-codex" | "xai" } {
  if (!object(credential) || credential.type !== "oauth") return {};
  const token = credential.access;
  if (typeof token !== "string") return {};
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
  if (!object(claims)) return {};
  const match = OAUTH_VENDORS.find(
    (candidate) => claims.iss === candidate.issuer && claims.client_id === candidate.client,
  );
  const profile = claims["https://api.openai.com/profile"];
  const email = object(profile) ? profile.email : claims.email;
  return {
    ...(typeof email === "string" && email.length > 0 && email.length <= 512
      ? { label: email }
      : {}),
    ...(match ? { vendor: match.vendor } : {}),
  };
}
function writeAuth(filename: string, content: string): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function removeOwnedFiles(dir: string): void {
  rmSync(path.join(dir, "index.ts"), { force: true });
  rmSync(path.join(dir, "import.json"), { force: true });
  try {
    rmdirSync(dir);
  } catch {
    /* Preserve user-added files. */
  }
}

/** Resolve the installed npm Pi, never a vendored SDK or an unrelated global install. */
async function installation(
  command: string | undefined,
  environment: NodeJS.ProcessEnv,
  authPath: string,
): Promise<PiCredentialInstallation> {
  const executable = await realpath(
    resolvePiExecutable({ ...(command ? { command } : {}), environment }),
  );
  let directory = path.dirname(executable);
  while (true) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") break;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error("Pi credential import requires a supported npm Pi installation");
    directory = parent;
  }
  // Native lock implementation coordinates with Pi's own auth.json writers.
  const storage = await import(
    pathToFileURL(path.join(directory, "dist/core/auth-storage.js")).href
  );
  const ai = path.join(directory, "node_modules/@earendil-works/pi-ai/dist");
  const all = await import(pathToFileURL(path.join(ai, "providers/all.js")).href);
  const providers = all.getBuiltinProviders();
  const providerModules = {
    "openai-codex": pathToFileURL(path.join(ai, "providers/openai-codex.js")).href,
    xai: pathToFileURL(path.join(ai, "providers/xai.js")).href,
  };
  for (const [id, url] of Object.entries(providerModules)) {
    const module = await import(url);
    const provider = id === "xai" ? module.xaiProvider() : module.openaiCodexProvider();
    if (!provider.auth?.oauth || !provider.getModels().length)
      throw new Error("Pi version does not support subscription imports");
  }
  return {
    backend: new storage.FileAuthStorageBackend(authPath),
    providerModules,
    reservedNames: providers.map((p: { id: string } | string) =>
      typeof p === "string" ? p : p.id,
    ),
    async configuredProviderNames() {
      // Native offline catalog includes providers registered by installed extensions.
      // This creates no Turn and passes no credential material on the command line.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [executable, "--offline", "--no-approve", "--list-models"],
        {
          cwd: existsSync(path.dirname(authPath)) ? path.dirname(authPath) : os.homedir(),
          env: { ...environment, PI_CODING_AGENT_DIR: path.dirname(authPath), PI_OFFLINE: "1" },
          timeout: 15_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0] ?? "")
        .filter(Boolean);
    },
  };
}

function extensionSource(
  moduleUrl: string,
  provider: "openai-codex" | "xai",
  name: string,
  owner: string,
): string {
  return `// Managed by codexhost. Removing this file disables the imported Provider.\nexport default async function (pi) {\n  const moduleUrl = ${JSON.stringify(moduleUrl)};\n  const nativeModule = await import(moduleUrl);\n  const native = nativeModule.${provider === "xai" ? "xaiProvider" : "openaiCodexProvider"}();\n  const oauth = native.auth.oauth;\n  const models = native.getModels().map(model => ({ ...model, provider: ${JSON.stringify(name)} }));\n  pi.registerProvider({\n    ...native, id: ${JSON.stringify(name)}, name: ${JSON.stringify(name)},\n    auth: { oauth: { ...oauth,\n      async refresh(credential, signal) {\n        return { ...await oauth.refresh(credential, signal), codexhostImportId: ${JSON.stringify(owner)} };\n      }\n    } },\n    getModels: () => models\n  });\n}\n`;
}

export function createPiCredentialImports(
  options: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    resolveInstallation?: (authPath: string) => Promise<PiCredentialInstallation>;
    writeAuth?: (filename: string, content: string) => void;
  } = {},
): HarnessCredentialImports {
  const env = { ...process.env, ...options.environment };
  const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(env.HOME ?? os.homedir(), ".pi/agent");
  const authPath = path.join(agentDir, "auth.json");
  const extensionsDir = path.join(agentDir, "extensions");
  const saveAuth = (auth: Record<string, unknown>) =>
    (options.writeAuth ?? writeAuth)(authPath, JSON.stringify(auth, null, 2) + "\n");
  const resolve = () =>
    options.resolveInstallation?.(authPath) ?? installation(options.command, env, authPath);
  const location = (name: string) =>
    path.join(extensionsDir, `${PREFIX}${credentialImportNameSchema.parse(name)}`);
  const readRecord = (name: string): RecordFile => {
    const dir = location(name);
    if (lstatSync(dir).isSymbolicLink())
      throw new Error("Imported configuration was changed; manage it in Pi");
    const value = JSON.parse(readFileSync(path.join(dir, "import.json"), "utf8"));
    if (
      value.version !== 1 ||
      typeof value.owner !== "string" ||
      typeof value.extension !== "string"
    )
      throw new Error("Invalid import metadata");
    const record: unknown = value.record;
    if (!object(record)) throw new Error("Invalid import metadata");
    // Pick fields explicitly: metadata written by earlier versions carries extra keys.
    value.record = credentialImportRecordSchema.parse({
      name: record.name,
      source: record.source,
      importedAt: record.importedAt,
    });
    if (value.record.name !== name) throw new Error("Import identity mismatch");
    return value;
  };
  const owned = (meta: RecordFile, auth: Record<string, unknown>) => {
    const credential = auth[meta.record.name];
    const file = path.join(location(meta.record.name), "index.ts");
    return (
      existsSync(file) &&
      !lstatSync(file).isSymbolicLink() &&
      readFileSync(file, "utf8") === meta.extension &&
      object(credential) &&
      credential.type === "oauth" &&
      credential.codexhostImportId === meta.owner
    );
  };
  const readAuth = (): Record<string, unknown> =>
    existsSync(authPath) ? parseAuth(readFileSync(authPath, "utf8")) : {};
  /**
   * Imports codexhost still owns. An entry the user rewrote or deleted in Pi is no longer ours, so
   * it drops out of this list silently and, when a credential remains, shows up as a Pi login.
   */
  const ownedRecords = (auth: Record<string, unknown>): CredentialImportRecord[] => {
    if (!existsSync(extensionsDir)) return [];
    const result: CredentialImportRecord[] = [];
    for (const entry of readdirSync(extensionsDir)) {
      if (!entry.startsWith(PREFIX)) continue;
      const name = entry.slice(PREFIX.length);
      if (!credentialImportNameSchema.safeParse(name).success) continue;
      if (!existsSync(path.join(location(name), "import.json"))) continue;
      try {
        const meta = readRecord(name);
        if (owned(meta, auth)) result.push(meta.record);
      } catch {
        // Unreadable or externally rewritten metadata is not ours to list.
      }
    }
    return result;
  };
  return {
    providers: ["openai-codex", "xai"],
    async list() {
      // Unsupported/missing Pi must not advertise an actionable target. A Pi that was never run has
      // no agent directory to import into, so it is not a target either and nothing is shown.
      if (!existsSync(agentDir)) throw new Error("Pi has no configuration directory");
      await resolve();
      return ownedRecords(readAuth());
    },
    async listOthers() {
      // Provider, type, and a locally derived account label and vendor. No values, no expiries.
      const auth = readAuth();
      const ours = new Set(ownedRecords(auth).map((record) => record.name));
      const result = new Map<string, CredentialOtherLogin>();
      const usable = (provider: string) =>
        Boolean(provider) && provider.length <= 128 && !ours.has(provider) && !result.has(provider);
      for (const [provider, credential] of Object.entries(auth)) {
        if (!usable(provider)) continue;
        const type = object(credential) ? credential.type : undefined;
        result.set(provider, {
          provider,
          type: type === "oauth" || type === "api_key" ? type : "unknown",
          ...describeOauth(credential),
        });
      }
      // Custom Providers can keep their key in models.json instead. Providers configured there that
      // authenticate through auth.json are already listed above, so only keyed ones are added.
      const modelsPath = path.join(agentDir, "models.json");
      if (existsSync(modelsPath)) {
        const models: unknown = JSON.parse(readFileSync(modelsPath, "utf8"));
        const providers = object(models) && object(models.providers) ? models.providers : {};
        for (const [provider, definition] of Object.entries(providers)) {
          if (!usable(provider) || !object(definition) || !definition.apiKey) continue;
          const name = definition.name;
          const label = typeof name === "string" && name && name !== provider ? name : undefined;
          result.set(provider, { provider, type: "api_key", ...(label ? { label } : {}) });
        }
      }
      return [...result.values()].sort((a, b) => a.provider.localeCompare(b.provider));
    },
    async add(name: string, transfer: HarnessCredentialTransfer) {
      credentialImportNameSchema.parse(name);
      const sdk = await resolve();
      if (!this.providers.includes(transfer.source.provider))
        throw new Error("Unsupported credential source");
      if (
        sdk.reservedNames.includes(name) ||
        (await sdk.configuredProviderNames?.())?.includes(name)
      )
        throw new Error("Provider name already exists; choose another name");
      const owner = randomUUID();
      const record = credentialImportRecordSchema.parse({
        name,
        source: transfer.source,
        importedAt: new Date().toISOString(),
      });
      const extension = extensionSource(
        sdk.providerModules[transfer.source.provider],
        transfer.source.provider,
        name,
        owner,
      );
      const dir = location(name);
      let created = false;
      let committed = false;
      try {
        sdk.backend.withLock((current) => {
          const auth = parseAuth(current);
          const modelsPath = path.join(agentDir, "models.json");
          const models = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : {};
          if (
            Object.hasOwn(auth, name) ||
            Object.hasOwn(models.providers ?? {}, name) ||
            existsSync(dir) ||
            existsSync(path.join(extensionsDir, `${name}-provider.ts`))
          )
            throw new Error("Provider name already exists; choose another name");
          mkdirSync(extensionsDir, { recursive: true, mode: 0o700 });
          mkdirSync(dir, { mode: 0o700 });
          created = true;
          writeFileSync(
            path.join(dir, "import.json"),
            JSON.stringify({ version: 1, owner, record, extension }),
            { flag: "wx", mode: 0o600 },
          );
          writeFileSync(path.join(dir, "index.ts"), extension, { flag: "wx", mode: 0o600 });
          auth[name] = { type: "oauth", ...transfer.oauth, codexhostImportId: owner };
          saveAuth(auth);
          committed = true;
          return { result: undefined };
        });
      } catch (error) {
        if (created && !committed) removeOwnedFiles(dir);
        throw error;
      }
    },
    async reimport(name: string, transfer: HarnessCredentialTransfer) {
      const sdk = await resolve();
      sdk.backend.withLock((current) => {
        const meta = readRecord(name);
        const auth = parseAuth(current);
        if (
          !owned(meta, auth) ||
          meta.record.source.id !== transfer.source.id ||
          meta.record.source.provider !== transfer.source.provider
        )
          throw new Error("Import ownership or source account changed; refusing replacement");
        const metadataPath = path.join(location(name), "import.json");
        const previous = readFileSync(metadataPath, "utf8");
        const updated = {
          ...meta,
          record: { ...meta.record, importedAt: new Date().toISOString() },
        };
        writeAuth(metadataPath, JSON.stringify(updated));
        try {
          saveAuth({
            ...auth,
            [name]: { type: "oauth", ...transfer.oauth, codexhostImportId: meta.owner },
          });
        } catch (error) {
          writeAuth(metadataPath, previous);
          throw error;
        }
        return { result: undefined };
      });
    },
    async remove(name: string) {
      const sdk = await resolve();
      const meta = readRecord(name);
      sdk.backend.withLock((current) => {
        const auth = parseAuth(current);
        if (!owned(meta, auth))
          throw new Error("Imported configuration was changed; manage it in Pi");
        saveAuth(Object.fromEntries(Object.entries(auth).filter(([key]) => key !== name)));
        removeOwnedFiles(location(name));
        return { result: undefined };
      });
    },
  };
}

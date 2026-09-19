import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { NativeCheckpointRef, NativeSessionRef } from "@codexhost/shared-contracts";
import type { CursorTransportOptions } from "./transport.js";
import {
  cursorConfigDirectory,
  cursorSessionDirectory,
  readCursorNativeTurns,
} from "./native-history.js";
import { cursorForkAvailable } from "./fork-support.js";
import { runCursorForkTerminal } from "./fork-terminal.js";

async function copySnapshot(source: string, target: string) {
  const db = new DatabaseSync(path.join(source, "store.db"), { readOnly: true });
  try {
    await backup(db, path.join(target, "store.db"));
  } finally {
    db.close();
  }
  await copyFile(path.join(source, "meta.json"), path.join(target, "meta.json"));
}

function storeIdentity(directory: string, hashBlobs = true) {
  const db = new DatabaseSync(path.join(directory, "store.db"), { readOnly: true });
  try {
    db.exec("BEGIN");
    const value = db.prepare("SELECT value FROM meta WHERE key = '0'").get()?.value;
    if (
      typeof value !== "string" ||
      value.length > 1_000_000 ||
      !/^(?:[0-9a-f]{2})+$/iu.test(value)
    )
      throw new Error("Invalid Cursor fork metadata");
    const data: unknown = JSON.parse(Buffer.from(value, "hex").toString("utf8"));
    if (
      !data ||
      typeof data !== "object" ||
      !("agentId" in data) ||
      typeof data.agentId !== "string" ||
      !("latestRootBlobId" in data) ||
      typeof data.latestRootBlobId !== "string" ||
      !/^[0-9a-f]{64}$/u.test(data.latestRootBlobId)
    )
      throw new Error("Invalid Cursor fork identity");
    const hash = createHash("sha256");
    for (const row of hashBlobs
      ? db.prepare("SELECT id, data FROM blobs ORDER BY id").iterate()
      : []) {
      if (typeof row.id !== "string" || !(row.data instanceof Uint8Array))
        throw new Error("Invalid Cursor fork blob");
      hash.update(row.id).update(row.data);
    }
    return { agentId: data.agentId, root: data.latestRootBlobId, blobs: hash.digest("hex") };
  } finally {
    db.close();
  }
}

export function validateCursorFork(source: NativeSessionRef, checkpoint: NativeCheckpointRef) {
  if (
    source.harnessId !== "cursor-cli" ||
    checkpoint.harnessId !== "cursor-cli" ||
    checkpoint.nativeSessionId !== source.nativeSessionId ||
    checkpoint.formatVersion !== 1 ||
    source.formatVersion !== 1 ||
    !checkpoint.locator ||
    typeof checkpoint.locator !== "object" ||
    Array.isArray(checkpoint.locator) ||
    (checkpoint.locator.kind !== "cursor-tail" && checkpoint.locator.kind !== "cursor-turn")
  )
    throw new Error("Invalid Cursor fork checkpoint");
}

/** A transaction owns only the new target. No checkpoint means rollback of the last turn.
 * Call commit only after ACP has verified replay. */
export async function forkCursorSession(
  source: NativeSessionRef,
  checkpoint: NativeCheckpointRef | undefined,
  options: CursorTransportOptions,
  signal: AbortSignal,
) {
  if (checkpoint) validateCursorFork(source, checkpoint);
  else if (source.harnessId !== "cursor-cli" || source.formatVersion !== 1)
    throw new Error("Invalid Cursor rollback source");
  if (!cursorForkAvailable()) throw new Error("Cursor fork requires the POSIX script utility");
  const sourceDirectory = cursorSessionDirectory(source.nativeSessionId, options.environment);
  const sourceTurns = readCursorNativeTurns(
    source.nativeSessionId,
    options.cwd,
    options.environment,
  );
  const retained = checkpoint
    ? sourceTurns.findIndex((turn) => turn.id === checkpoint.checkpointId) + 1
    : sourceTurns.length - 1;
  if (!sourceTurns.length || (checkpoint && retained === 0))
    throw new Error("Cursor derivation boundary does not exist");
  const expected = sourceTurns.slice(0, retained);
  const rewindTurn = sourceTurns[retained];
  if (rewindTurn && !rewindTurn.rewindRoot)
    throw new Error("Cursor target has no native rewind checkpoint");
  const original = storeIdentity(sourceDirectory);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "codexhost-cursor-fork-"));
  let target: string | undefined;
  let committed = false;
  const discard = async () => {
    if (target && !committed) await rm(target, { recursive: true, force: true });
  };
  try {
    signal.throwIfAborted();
    const config = path.join(temporary, "config");
    await mkdir(config, { mode: 0o700 });
    // Preserve native login/network/policy settings; never expose this private temporary file.
    const nativeConfig = path.join(cursorConfigDirectory(options.environment), "cli-config.json");
    let settings: Record<string, unknown> = {};
    try {
      const data: unknown = JSON.parse(await readFile(nativeConfig, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid Cursor CLI configuration");
      settings = data as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    // Enable native rewind only in this operation's private config, never in the user's config.
    await writeFile(
      path.join(config, "cli-config.json"),
      JSON.stringify({ ...settings, rewind: true }),
      { mode: 0o600 },
    );
    // The interactive CLI hashes process.cwd(), which resolves symlinks (e.g. /var on macOS).
    const chats = path.join(
      config,
      "chats",
      createHash("md5")
        .update(await realpath(options.cwd))
        .digest("hex"),
    );
    const copy = path.join(chats, source.nativeSessionId);
    await mkdir(copy, { recursive: true });
    await copySnapshot(sourceDirectory, copy);
    if (JSON.stringify(storeIdentity(copy)) !== JSON.stringify(original))
      throw new Error("Cursor source changed while preparing fork");
    await runCursorForkTerminal(
      {
        ...options,
        environment: {
          ...options.environment,
          CURSOR_CONFIG_DIR: config,
          CURSOR_DATA_DIR: path.join(temporary, "data"),
        },
      },
      source.nativeSessionId,
      signal,
      rewindTurn
        ? {
            steps: sourceTurns.slice(retained).filter((turn) => turn.rewindRoot).length,
            complete: () => {
              const targets = readdirSync(chats).filter((id) => id !== source.nativeSessionId);
              const targetId = targets[0];
              return (
                targets.length === 1 &&
                !!targetId &&
                storeIdentity(path.join(chats, targetId), false).root === rewindTurn.rewindRoot
              );
            },
          }
        : undefined,
    );
    signal.throwIfAborted();
    const children = (await readdir(chats, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && entry.name !== source.nativeSessionId,
    );
    if (children.length !== 1 || !children[0])
      throw new Error("Cursor fork did not create one independent session");
    const sessionId = children[0].name;
    const destination = cursorSessionDirectory(sessionId, options.environment);
    const nativeFork = path.join(chats, sessionId);
    const forked = storeIdentity(nativeFork);
    if (
      forked.agentId !== sessionId ||
      forked.root !== (rewindTurn?.rewindRoot ?? original.root) ||
      forked.blobs !== original.blobs
    )
      throw new Error("Cursor native fork changed conversation contents or identity");
    if (JSON.stringify(storeIdentity(sourceDirectory)) !== JSON.stringify(original))
      throw new Error("Cursor source changed during fork");
    // Exclusive mkdir: never overwrite an existing native session, including on failure cleanup.
    await mkdir(destination);
    target = destination;
    await copySnapshot(nativeFork, target);
    if (
      JSON.stringify(readCursorNativeTurns(sessionId, options.cwd, options.environment)) !==
      JSON.stringify(expected)
    )
      throw new Error("Cursor fork history does not match source");
    return {
      sessionId,
      expected,
      sourceTurns,
      commit: () => {
        signal.throwIfAborted();
        committed = true;
      },
      discard,
    };
  } catch (error) {
    await discard();
    throw error;
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      await discard();
      throw error;
    }
  }
}

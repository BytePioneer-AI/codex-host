import { constants } from "node:fs";
import { open } from "node:fs/promises";

export interface MutationGuard {
  close(): Promise<void>;
}

/** Hold the stable guard file by OS handle, never by its existence. */
export async function openMutationGuard(file: string): Promise<MutationGuard> {
  let exclusiveFlags: number;
  if (process.platform === "win32") {
    // libuv's public uv/win.h defines UV_FS_O_EXLOCK = 0x10000000.
    // fs.open forwards numeric flags; libuv opens with FILE_SHARE_* = 0.
    // Rust uses the same exclusive sharing mode, so no lock file is unlinked.
    exclusiveFlags = 0x10000000;
  } else if (process.platform === "darwin") {
    // BSD O_EXLOCK | O_NONBLOCK permits native process-lifetime fixture tests.
    // macOS production update coordination does not use the Windows guard.
    exclusiveFlags = 0x20 | constants.O_NONBLOCK;
  } else {
    throw new Error("Windows update mutation guard requires Windows");
  }
  const flags = constants.O_RDWR | constants.O_CREAT | exclusiveFlags;
  const guard = await open(file, flags, 0o600);
  let contender: MutationGuard;
  try {
    contender = await open(file, flags, 0o600);
  } catch (error) {
    if (
      ["EACCES", "EPERM", "EBUSY", "EAGAIN"].includes(String((error as NodeJS.ErrnoException).code))
    )
      return guard;
    await guard.close();
    throw error;
  }
  // Do not silently enter a critical section if an engine/filesystem ignored
  // the exclusive-open flag. Both handles are closed before reporting failure.
  try {
    await contender.close();
  } finally {
    await guard.close();
  }
  throw new Error("Exclusive update metadata handles are unavailable");
}

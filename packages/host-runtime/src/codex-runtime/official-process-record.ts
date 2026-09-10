import { randomUUID } from "node:crypto";
import { z } from "zod";
import { privateFileDigest, type NativePrivateFiles } from "../native-private-files.js";
import type { OwnedOfficialBackend } from "./official-runtime-owner.js";
import type { ProcessExitReceipt } from "../native-process-relay.js";

const recordSchema = z.discriminatedUnion("phase", [
  z
    .object({ version: z.literal(1), nonce: z.string().uuid(), phase: z.literal("starting") })
    .strict(),
  z
    .object({
      version: z.literal(1),
      nonce: z.string().uuid(),
      phase: z.literal("running"),
      pid: z.number().int().positive().max(2_147_483_647),
      identity: z.string().min(1).max(256),
    })
    .strict(),
]);
type ProcessRecord = z.infer<typeof recordSchema>;
const name = ".codexhost-process.json";
const receiptName = ".codexhost-process-exit.json";
const receiptSchema = z
  .object({
    version: z.literal(1),
    tag: z.string().uuid(),
    pid: z.number().int().positive(),
    treeExited: z.literal(true),
  })
  .strict();

/** Shared-home writer witness. A crash in the spawn/record gap is unknown, never "stopped". */
export class OfficialProcessRecord {
  readonly #files: Pick<NativePrivateFiles, "read" | "replace" | "remove">;
  readonly #home: string;
  readonly #identity: (pid: number) => Promise<string | null>;
  readonly #assertOwnership: () => void;
  readonly #supervisorExitClosesProcessTree: boolean;

  constructor(input: {
    files: Pick<NativePrivateFiles, "read" | "replace" | "remove">;
    sharedCodexHome: string;
    identity(pid: number): Promise<string | null>;
    assertOwnership(): void;
    /** Windows supervisor owns a non-inheritable KILL_ON_JOB_CLOSE Job handle. */
    supervisorExitClosesProcessTree?: boolean;
  }) {
    this.#files = input.files;
    this.#home = input.sharedCodexHome;
    this.#identity = input.identity;
    this.#assertOwnership = input.assertOwnership;
    this.#supervisorExitClosesProcessTree = input.supervisorExitClosesProcessTree ?? false;
  }

  async reconcile(): Promise<void> {
    this.#assertOwnership();
    const previous = await this.#read();
    if (!previous) {
      await this.#removeReceipt();
      return;
    }
    let closedWindowsJob = false;
    if (previous.record.phase === "running") {
      const current = await this.#identity(previous.record.pid);
      if (current === previous.record.identity)
        throw new Error("Previous official process is still running");
      // This PID identifies our native supervisor, not the official root. On
      // Windows that exact helper exclusively owns a non-inheritable Job handle
      // configured with KILL_ON_JOB_CLOSE, so confirmed helper exit/reuse is
      // kernel proof that the whole owned process tree was terminated.
      closedWindowsJob = this.#supervisorExitClosesProcessTree;
    }
    const receipt = await this.#receipt();
    if ((receipt && receipt.tag !== previous.record.nonce) || (!receipt && !closedWindowsJob))
      throw new Error("Official process tree exit is unconfirmed");
    this.#assertOwnership();
    await this.#files.remove(this.#home, name, privateFileDigest(previous.bytes));
    if (receipt) await this.#removeReceipt(previous.record.nonce);
  }

  wrap(create: (receipt: ProcessExitReceipt) => OwnedOfficialBackend): OwnedOfficialBackend {
    const nonce = randomUUID();
    const backend = create({ directory: this.#home, name: receiptName, tag: nonce });
    let prepared = false;
    return {
      closed: backend.closed,
      get processId() {
        return backend.processId;
      },
      start: async () => {
        await this.reconcile();
        this.#assertOwnership();
        prepared = true;
        await this.#files.replace(
          this.#home,
          name,
          Buffer.from(JSON.stringify({ version: 1, nonce, phase: "starting" })),
          null,
        );
        try {
          await backend.start();
        } finally {
          await this.#recordStarted(backend.processId, nonce);
        }
      },
      connect: () => backend.connect(),
      stop: async () => {
        await backend.stop();
        await backend.closed;
        if (!prepared) return;
        this.#assertOwnership();
        const previous = await this.#read();
        if (previous === null) return;
        if (previous.record.nonce !== nonce) throw new Error("Official process ownership changed");
        await this.#files.remove(this.#home, name, privateFileDigest(previous.bytes));
        await this.#removeReceipt(nonce);
      },
    };
  }

  async #receipt(): Promise<{ bytes: Buffer; tag: string } | null> {
    const bytes = await this.#files.read(this.#home, receiptName);
    if (!bytes) return null;
    try {
      return { bytes, tag: receiptSchema.parse(JSON.parse(bytes.toString("utf8"))).tag };
    } catch {
      throw new Error("Official process receipt is invalid");
    }
  }

  async #removeReceipt(nonce?: string): Promise<void> {
    const receipt = await this.#receipt();
    if (!receipt) return;
    if (nonce !== undefined && receipt.tag !== nonce)
      throw new Error("Official process ownership changed");
    this.#assertOwnership();
    await this.#files.remove(this.#home, receiptName, privateFileDigest(receipt.bytes));
  }

  async #recordStarted(pid: number | undefined, nonce: string): Promise<void> {
    if (pid === undefined) throw new Error("Official process identity is unavailable");
    const identity = await this.#identity(pid);
    if (identity === null) throw new Error("Official process identity is unavailable");
    this.#assertOwnership();
    const previous = await this.#read();
    if (previous?.record.nonce !== nonce) throw new Error("Official process ownership changed");
    await this.#files.replace(
      this.#home,
      name,
      Buffer.from(JSON.stringify({ version: 1, nonce, phase: "running", pid, identity })),
      privateFileDigest(previous.bytes),
    );
  }

  async #read(): Promise<{ bytes: Buffer; record: ProcessRecord } | null> {
    const bytes = await this.#files.read(this.#home, name);
    if (bytes === null) return null;
    try {
      return { bytes, record: recordSchema.parse(JSON.parse(bytes.toString("utf8"))) };
    } catch {
      throw new Error("Official process ownership record is invalid");
    }
  }
}

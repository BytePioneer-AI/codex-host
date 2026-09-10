import { z } from "zod";

import { privateFileDigest } from "../native-private-files.js";
import type { CredentialFileAccess } from "./codex-credential-files.js";

const journalSchema = z
  .object({
    version: z.literal(1),
    transactionId: z.string().uuid(),
    operation: z.enum(["switch", "login"]),
    sourceAccountId: z.string().uuid().nullable(),
    targetAccountId: z.string().uuid(),
    stage: z.enum(["prepared", "source-saved", "target-installed", "verified"]),
  })
  .strict();
export type CredentialSwitchRecord = z.infer<typeof journalSchema>;
export interface CredentialSwitchJournal {
  read(): Promise<CredentialSwitchRecord | null>;
  write(record: CredentialSwitchRecord): Promise<void>;
  clear(): Promise<void>;
}

/** Small non-secret record beside the private slots; caller holds the shared-home lease. */
export class FileCredentialSwitchJournal implements CredentialSwitchJournal {
  readonly #files: CredentialFileAccess;
  readonly #directory: string;
  constructor(files: CredentialFileAccess, directory: string) {
    this.#files = files;
    this.#directory = directory;
  }

  async read(): Promise<CredentialSwitchRecord | null> {
    const bytes = await this.#files.read(this.#directory, "transaction.json");
    if (bytes === null) return null;
    try {
      return journalSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new Error("Codex credential transaction record is invalid");
    }
  }

  async write(record: CredentialSwitchRecord): Promise<void> {
    const parsed = journalSchema.safeParse(record);
    if (!parsed.success) throw new Error("Codex credential transaction record is invalid");
    const previous = await this.#files.read(this.#directory, "transaction.json");
    await this.#files.replace(
      this.#directory,
      "transaction.json",
      Buffer.from(JSON.stringify(parsed.data)),
      previous === null ? null : privateFileDigest(previous),
    );
  }

  async clear(): Promise<void> {
    const previous = await this.#files.read(this.#directory, "transaction.json");
    if (previous !== null)
      await this.#files.remove(this.#directory, "transaction.json", privateFileDigest(previous));
  }
}

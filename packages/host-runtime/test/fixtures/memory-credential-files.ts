import type { PrivateCredentialFiles } from "../../src/account/native-account-store.js";
import { privateFileDigest, type NativePrivateFileLease } from "../../src/native-private-files.js";

/** Synthetic-only fault injection; does not claim to implement OS permissions. */
export class MemoryCredentialFiles implements PrivateCredentialFiles {
  readonly contents = new Map<string, Buffer>();
  beforeReplace: ((directory: string, name: string) => void) | undefined;
  afterReplace: ((directory: string, name: string) => void) | undefined;
  async ensureDirectory(directory: string): Promise<void> {
    void directory;
  }
  async lock(directory: string, name: string): Promise<NativePrivateFileLease> {
    void directory;
    void name;
    const closed = Promise.withResolvers<{ code: number; signal: null }>();
    return {
      closed: closed.promise,
      release: async () => {
        closed.resolve({ code: 0, signal: null });
      },
    };
  }
  nativeWrite(directory: string, name: string, value: string): void {
    this.contents.set(`${directory}/${name}`, Buffer.from(value));
  }
  async read(directory: string, name: string): Promise<Buffer | null> {
    const bytes = this.contents.get(`${directory}/${name}`);
    return bytes ? Buffer.from(bytes) : null;
  }
  async replace(
    directory: string,
    name: string,
    content: Uint8Array,
    expected: string | null,
  ): Promise<void> {
    this.beforeReplace?.(directory, name);
    const previous = await this.read(directory, name);
    if ((previous ? privateFileDigest(previous) : null) !== expected)
      throw new Error("Synthetic file conflict");
    this.contents.set(`${directory}/${name}`, Buffer.from(content));
    this.afterReplace?.(directory, name);
  }
  async remove(directory: string, name: string, expected: string): Promise<void> {
    const previous = await this.read(directory, name);
    if (!previous || privateFileDigest(previous) !== expected)
      throw new Error("Synthetic file conflict");
    this.contents.delete(`${directory}/${name}`);
  }
}

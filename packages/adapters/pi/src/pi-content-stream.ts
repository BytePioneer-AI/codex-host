export class PiContentStreamConflictError extends Error {}

type ContentBlock = { received: string; emitted: string; ended: boolean };

/** Pi end events carry authoritative block content; Host text events are append-only. */
export class PiContentStream {
  readonly #blocks = new Map<number, ContentBlock>();
  #indexed: boolean | undefined;
  #legacyBlockIndex = 0;
  #lastEmittedIndex = -Infinity;

  constructor(readonly kind: "text" | "reasoning") {}

  append(index: unknown, delta: string): string {
    const block = this.#block(this.#key(index));
    if (block.ended && delta.length > 0) this.#conflict();
    block.received += delta;
    return this.#flush();
  }

  complete(index: unknown, content: string): string {
    this.#finish(this.#key(index), content);
    if (this.#indexed === false) this.#legacyBlockIndex += 1;
    return this.#flush();
  }

  finalize(blocks: { index: number; text: string }[]): string {
    if (this.#indexed !== true) {
      // Unindexed end events still delimit blocks. Without them only the
      // aggregate lane can be reconciled, preserving legacy RPC support.
      blocks =
        this.#legacyBlockIndex > 0
          ? blocks.map(({ text }, index) => ({ index, text }))
          : [{ index: 0, text: blocks.map(({ text }) => text).join("") }];
    }
    const indices = new Set(blocks.map(({ index }) => index));
    for (const [index, block] of this.#blocks) {
      if (indices.has(index)) continue;
      if (block.emitted.length > 0) this.#conflict();
      this.#blocks.delete(index);
    }
    for (const { index, text } of blocks) this.#finish(index, text);
    return this.#flush();
  }

  #key(index: unknown): number {
    const indexed = typeof index === "number" && Number.isInteger(index) && index >= 0;
    // Older RPC variants omit contentIndex and expose one aggregate content lane.
    this.#indexed ??= indexed;
    if (!this.#indexed) return this.#legacyBlockIndex;
    if (!indexed) this.#conflict();
    return index as number;
  }

  #block(index: number): ContentBlock {
    let block = this.#blocks.get(index);
    if (!block) {
      block = { received: "", emitted: "", ended: false };
      this.#blocks.set(index, block);
    }
    return block;
  }

  #finish(index: number, content: string): void {
    const block = this.#block(index);
    if (!content.startsWith(block.emitted)) this.#conflict();
    block.received = content;
    block.ended = true;
  }

  #flush(): string {
    let delta = "";
    for (const [index, block] of [...this.#blocks].sort(([left], [right]) => left - right)) {
      // Responses emits summary separators, then removes the last one at thinking_end.
      // Hold trailing line breaks until more text or the authoritative end arrives.
      const visible =
        this.kind === "reasoning" && !block.ended
          ? block.received.replace(/[\r\n]+$/u, "")
          : block.received;
      if (!visible.startsWith(block.emitted)) this.#conflict();
      const suffix = visible.slice(block.emitted.length);
      if (suffix.length > 0) {
        if (index < this.#lastEmittedIndex) this.#conflict();
        this.#lastEmittedIndex = index;
        block.emitted = visible;
        delta += suffix;
      }
      // A later block may stream before this one's end. Buffer it so a missing
      // earlier suffix can still be inserted in order when the end event arrives.
      if (!block.ended) break;
    }
    return delta;
  }

  #conflict(): never {
    throw new PiContentStreamConflictError(
      `Pi ${this.kind} final content conflicts with already streamed content`,
    );
  }
}

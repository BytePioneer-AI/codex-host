const TOOL_PREAMBLE = "<\uff5cDSML\uff5cfunction_calls";
const FENCES = ["```", "~~~"];

/** Suppress the standalone, unterminated preamble leaked by Kiro's native text stream. */
export class KiroVisibleText {
  #pending = "";
  #passthrough = false;
  #fence: string | undefined;

  push(chunk: string): string {
    let output = "";
    for (const character of chunk) {
      if (character === "\n") {
        output += this.#flushLine() + "\n";
        continue;
      }
      if (this.#passthrough) {
        output += character;
        continue;
      }
      this.#pending += character;
      const candidate = this.#pending.trimStart();
      const fence = FENCES.find((value) => candidate === value);
      if (fence) {
        if (!this.#fence) this.#fence = fence;
        else if (this.#fence === fence) this.#fence = undefined;
        output += this.#pending;
        this.#pending = "";
        this.#passthrough = true;
      } else if (
        !FENCES.some((value) => value.startsWith(candidate)) &&
        (this.#fence !== undefined ||
          (!TOOL_PREAMBLE.startsWith(candidate) && candidate.trimEnd() !== TOOL_PREAMBLE))
      ) {
        output += this.#pending;
        this.#pending = "";
        this.#passthrough = true;
      }
    }
    return output;
  }

  #flushLine(): string {
    const text = !this.#fence && this.#pending.trim() === TOOL_PREAMBLE ? "" : this.#pending;
    this.#pending = "";
    this.#passthrough = false;
    return text;
  }

  finish(): string {
    const text = this.#flushLine();
    this.#fence = undefined;
    return text;
  }
}

export function kiroVisibleText(text: string): string {
  const filter = new KiroVisibleText();
  return filter.push(text) + filter.finish();
}

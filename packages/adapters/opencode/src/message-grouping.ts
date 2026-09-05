import { createHash } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const GROUP_MARKER = "CH";
const RECOVERY_MARKER = "CR";
const GROUP_TOKEN_LENGTH = 10;
const SEQUENCE_LENGTH = 2;
const MAX_SEQUENCE = BASE62.length ** SEQUENCE_LENGTH - 1;
const TIME_COUNTER_BITS = 12n;
const TIME_HEX_LENGTH = 12;
const TIME_MASK = (1n << 48n) - 1n;
const MAX_COUNTER = Number((1n << TIME_COUNTER_BITS) - 1n);

export interface OpenCodeMessageGroupIdentity {
  readonly token: string;
  nextSequence: number;
}

export interface ParsedOpenCodeMessageGroup {
  readonly token: string;
  readonly sequence: number;
  readonly kind: "input" | "recovery";
}

function encodeBase62(value: number, width: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid OpenCode ID value");
  let remaining = value;
  let encoded = "";
  do {
    encoded = BASE62[remaining % BASE62.length] + encoded;
    remaining = Math.floor(remaining / BASE62.length);
  } while (remaining > 0);
  if (encoded.length > width) throw new Error("OpenCode ID value exceeds its encoded width");
  return encoded.padStart(width, "0");
}

function groupToken(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  return Array.from(digest.subarray(0, GROUP_TOKEN_LENGTH), (byte) => BASE62[byte % 62]).join("");
}

/**
 * Generates OpenCode-compatible ascending Message IDs. OpenCode encodes
 * `(timestamp * 0x1000) + counter` into six bytes and follows it with a 14-character Base62
 * suffix. We preserve that layout while namespacing the suffix so history reads can recover which
 * native User Messages belong to one Host Turn.
 */
export class OpenCodeMessageIdGenerator {
  #counter = 0;
  #lastTimestamp = 0;

  createGroup(seed: string): OpenCodeMessageGroupIdentity {
    return { token: groupToken(seed), nextSequence: 0 };
  }

  next(group: OpenCodeMessageGroupIdentity, now = Date.now()): string {
    // Keep the final sequence value available for the single recovery admission.
    return this.#next(group, GROUP_MARKER, MAX_SEQUENCE - 1, now);
  }

  nextRecovery(group: OpenCodeMessageGroupIdentity, now = Date.now()): string {
    return this.#next(group, RECOVERY_MARKER, MAX_SEQUENCE, now);
  }

  #next(
    group: OpenCodeMessageGroupIdentity,
    marker: typeof GROUP_MARKER | typeof RECOVERY_MARKER,
    maximumSequence: number,
    now: number,
  ): string {
    if (group.nextSequence > maximumSequence) {
      throw new Error("OpenCode active Turn has too many steering inputs");
    }
    let timestamp = Math.max(now, this.#lastTimestamp);
    if (timestamp === this.#lastTimestamp) {
      this.#counter += 1;
      if (this.#counter > MAX_COUNTER) {
        timestamp += 1;
        this.#counter = 1;
      }
    } else {
      this.#counter = 1;
    }
    this.#lastTimestamp = timestamp;
    const sortable = (BigInt(timestamp) << TIME_COUNTER_BITS) + BigInt(this.#counter);
    const timeHex = (sortable & TIME_MASK).toString(16).padStart(TIME_HEX_LENGTH, "0");
    const sequence = encodeBase62(group.nextSequence, SEQUENCE_LENGTH);
    group.nextSequence += 1;
    return `msg_${timeHex}${marker}${group.token}${sequence}`;
  }
}

export function parseOpenCodeMessageGroup(messageId: string): ParsedOpenCodeMessageGroup | null {
  const match = /^msg_[0-9a-f]{12}(CH|CR)([0-9A-Za-z]{10})([0-9A-Za-z]{2})$/u.exec(messageId);
  if (!match) return null;
  const marker = match[1];
  const token = match[2];
  const encodedSequence = match[3];
  if (!marker || !token || !encodedSequence) return null;
  let sequence = 0;
  for (const character of encodedSequence) {
    const digit = BASE62.indexOf(character);
    if (digit < 0) return null;
    sequence = sequence * BASE62.length + digit;
  }
  return { token, sequence, kind: marker === RECOVERY_MARKER ? "recovery" : "input" };
}

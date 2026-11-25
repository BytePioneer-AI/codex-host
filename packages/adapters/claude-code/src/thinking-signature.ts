/**
 * Claude Desktop's native narration classifier, read from the protobuf metadata
 * that Claude Code persists inside every thinking block's Base64 `signature`.
 *
 * Installed Claude Desktop 2.16120.0 (`.vite/build/index.chunk-lssHJSpz.js`,
 * exported `h` for internal `w`, with `S` for the signature read) marks a
 * thinking block as a user-facing narration only when its signature metadata
 * carries the exact type string:
 *
 *   Base64 (WHATWG atob) -> bytes field 2 -> bytes field 1 -> UTF-8 field 8 === "narration"
 *
 * Nothing else is interpreted: block position, language, and text content play
 * no part, and an encrypted or otherwise unrecognized payload is never decrypted
 * or guessed at. Missing, empty, non-Base64, truncated, malformed, and
 * differently shaped signatures all stay ordinary thinking, because the field
 * path is installed-build behavior rather than a published contract.
 */

import { atob } from "node:buffer";
import { TextDecoder } from "node:util";

const MAX_VARINT_BYTES = 10;

const WIRE_TYPE_VARINT = 0;
const WIRE_TYPE_FIXED_64 = 1;
const WIRE_TYPE_LENGTH_DELIMITED = 2;
const WIRE_TYPE_FIXED_32 = 5;

/** Outer signature message, its metadata message, and the kind string inside. */
const SIGNATURE_FIELD = 2;
const METADATA_FIELD = 1;
const KIND_FIELD = 8;

const NARRATION_KIND = "narration";

const kindDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

interface Varint {
  value: number;
  next: number;
}

/** Protobuf varint, bounded to 10 bytes like the Desktop reader. */
function readVarint(bytes: Uint8Array, offset: number): Varint | undefined {
  let value = 0;
  let factor = 1;
  for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
    const index = offset + i;
    if (index >= bytes.length) return undefined;
    const byte = bytes[index];
    if (byte === undefined) return undefined;
    value += (byte & 127) * factor;
    if ((byte & 128) === 0) return { value, next: index + 1 };
    factor *= 128;
  }
  return undefined;
}

/**
 * Payload of the last length-delimited field numbered `fieldNumber`, or
 * `undefined` when the message is malformed anywhere.
 *
 * Both details are deliberate copies of the Desktop original: it overwrites the
 * result on every match (last one wins) and fails the whole read on a malformed
 * tail, even if the wanted field parsed earlier.
 */
function readLengthDelimitedField(bytes: Uint8Array, fieldNumber: number): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (tag === undefined) return undefined;
    const wireType = tag.value & 7;
    const tagFieldNumber = Math.floor(tag.value / 8);
    offset = tag.next;
    switch (wireType) {
      case WIRE_TYPE_VARINT: {
        const field = readVarint(bytes, offset);
        if (field === undefined) return undefined;
        offset = field.next;
        break;
      }
      case WIRE_TYPE_FIXED_64:
        if (offset + 8 > bytes.length) return undefined;
        offset += 8;
        break;
      case WIRE_TYPE_LENGTH_DELIMITED: {
        const length = readVarint(bytes, offset);
        if (length === undefined || length.value > bytes.length - length.next) return undefined;
        const end = length.next + length.value;
        if (tagFieldNumber === fieldNumber) found = bytes.subarray(length.next, end);
        offset = end;
        break;
      }
      case WIRE_TYPE_FIXED_32:
        if (offset + 4 > bytes.length) return undefined;
        offset += 4;
        break;
      default:
        return undefined;
    }
  }
  return found;
}

/** The signature's kind string, or `undefined` when it cannot be read as one. */
function decodeSignatureKind(signature: string): string | undefined {
  let binary: string;
  try {
    binary = atob(signature);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const signed = readLengthDelimitedField(bytes, SIGNATURE_FIELD);
  if (signed === undefined) return undefined;
  const metadata = readLengthDelimitedField(signed, METADATA_FIELD);
  if (metadata === undefined) return undefined;
  const kind = readLengthDelimitedField(metadata, KIND_FIELD);
  return kind === undefined ? undefined : kindDecoder.decode(kind);
}

/**
 * Whether a Claude thinking block's `signature` marks the block as narration.
 *
 * The caller must already know the block is a thinking block; this reads only the
 * signature metadata, exactly like the Desktop classifier's signature branch.
 * Any input that is not the exact `narration` kind returns false.
 */
export function isClaudeNarrationSignature(signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  return decodeSignatureKind(signature) === NARRATION_KIND;
}

import { describe, expect, it } from "vitest";

import { isClaudeNarrationSignature } from "../src/thinking-signature.js";

/**
 * Synthetic protobuf fixtures. No real Claude signature is copied into this file:
 * every input is built here from the field layout the classifier reads.
 */

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);
  return bytes;
}

function lengthDelimited(fieldNumber: number, payload: readonly number[]): number[] {
  return [...varint((fieldNumber << 3) | 2), ...varint(payload.length), ...payload];
}

function varintField(fieldNumber: number, value: number): number[] {
  return [...varint(fieldNumber << 3), ...varint(value)];
}

function fixed64Field(fieldNumber: number): number[] {
  return [...varint((fieldNumber << 3) | 1), ...new Array<number>(8).fill(0)];
}

function fixed32Field(fieldNumber: number): number[] {
  return [...varint((fieldNumber << 3) | 5), ...new Array<number>(4).fill(0)];
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

function toBase64(bytes: readonly number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

/** field 2 -> field 1 -> UTF-8 field 8, the path the Desktop classifier reads. */
function kindBytes(kind: string): number[] {
  return lengthDelimited(2, lengthDelimited(1, lengthDelimited(8, utf8(kind))));
}

/** Test-only synthetic metadata; no production exports or real signatures. */
function syntheticClaudeSignature(kind: string): string {
  return toBase64(kindBytes(kind));
}

const narration = kindBytes("narration");
const unterminatedVarint = [...new Array<number>(10).fill(0x80)];

describe("isClaudeNarrationSignature", () => {
  it("accepts only the exact narration kind", () => {
    expect(isClaudeNarrationSignature(syntheticClaudeSignature("narration"))).toBe(true);
    for (const kind of [
      "thinking",
      "highlights",
      "Narration",
      "narration ",
      "narration\u0000",
      "",
    ]) {
      expect(isClaudeNarrationSignature(syntheticClaudeSignature(kind))).toBe(false);
    }
  });

  it("rejects missing, empty, and non-string signatures", () => {
    for (const signature of [undefined, null, 42, true, {}, [], "", () => "narration"]) {
      expect(isClaudeNarrationSignature(signature)).toBe(false);
    }
  });

  it("rejects signatures that Base64 decoding cannot read", () => {
    // atob throws on illegal characters, on the Base64URL alphabet, on length % 4 === 1.
    for (const signature of ["not-base64!!", "%%%%", "a", "AA-_"]) {
      expect(isClaudeNarrationSignature(signature)).toBe(false);
    }
  });

  it("rejects truncated or malformed protobuf payloads", () => {
    const truncated = [
      // field 2 declares 10 payload bytes, only 3 follow.
      [0x12, 0x0a, 1, 2, 3],
      // field 2 declares 127 payload bytes, then the intact narration message.
      [0x12, 0x7f, ...narration],
      // field 2 payload is an unterminated varint.
      [0x12, 0x0a, ...unterminatedVarint],
      // The leading tag itself is an unterminated varint.
      unterminatedVarint,
      // field 3 fixed64 with 3 of its 8 bytes.
      [0x19, 1, 2, 3],
      // field 6 fixed32 with 2 of its 4 bytes.
      [0x35, 1, 2],
      // field 3 under field 1 whose length varint is unterminated.
      lengthDelimited(2, lengthDelimited(1, [0x1a, 0x80])),
    ];
    for (const bytes of truncated) {
      expect(isClaudeNarrationSignature(toBase64(bytes))).toBe(false);
    }
  });

  it("rejects readable messages without the narration field path", () => {
    const unreachable = [
      // field 1 -> field 8, no outer field 2.
      lengthDelimited(1, lengthDelimited(8, utf8("narration"))),
      // field 2 -> field 8, skipping field 1.
      lengthDelimited(2, lengthDelimited(8, utf8("narration"))),
      // field 2 -> field 1 -> field 9, a different kind field.
      lengthDelimited(2, lengthDelimited(1, lengthDelimited(9, utf8("narration")))),
      // Empty containers at each level.
      lengthDelimited(2, []),
      lengthDelimited(2, lengthDelimited(1, [])),
      lengthDelimited(2, lengthDelimited(1, lengthDelimited(8, []))),
      // Kind bytes that are not valid UTF-8.
      lengthDelimited(2, lengthDelimited(1, lengthDelimited(8, [0xff, 0xfe]))),
    ];
    for (const bytes of unreachable) {
      expect(isClaudeNarrationSignature(toBase64(bytes))).toBe(false);
    }
  });

  it("skips unknown protobuf fields and rejects unsupported wire types", () => {
    const aroundKnown = [
      ...varintField(1, 5),
      ...fixed64Field(3),
      ...fixed32Field(6),
      ...lengthDelimited(2, [
        ...varintField(4, 9),
        ...lengthDelimited(1, [...lengthDelimited(8, utf8("narration")), ...varintField(2, 1)]),
        ...fixed64Field(5),
      ]),
      ...varintField(7, 1),
    ];
    expect(isClaudeNarrationSignature(toBase64(aroundKnown))).toBe(true);

    // Wire types 3, 4, 6, and 7 are not the four the reader accepts.
    for (const wireType of [3, 4, 6, 7]) {
      expect(isClaudeNarrationSignature(toBase64([(3 << 3) | wireType, ...narration]))).toBe(false);
      expect(
        isClaudeNarrationSignature(
          toBase64(lengthDelimited(2, [(4 << 3) | wireType, ...lengthDelimited(1, [])])),
        ),
      ).toBe(false);
    }
  });

  it("preserves the reference reader's duplicate and malformed-tail behavior", () => {
    // The last matching field wins, so a later thinking kind overrides narration.
    expect(
      isClaudeNarrationSignature(
        toBase64([
          ...narration,
          ...lengthDelimited(2, lengthDelimited(1, lengthDelimited(8, utf8("thinking")))),
        ]),
      ),
    ).toBe(false);
    expect(
      isClaudeNarrationSignature(
        toBase64([
          ...lengthDelimited(2, lengthDelimited(1, lengthDelimited(8, utf8("thinking")))),
          ...narration,
        ]),
      ),
    ).toBe(true);
    expect(
      isClaudeNarrationSignature(
        toBase64(
          lengthDelimited(
            2,
            lengthDelimited(1, [
              ...lengthDelimited(8, utf8("thinking")),
              ...lengthDelimited(8, utf8("narration")),
            ]),
          ),
        ),
      ),
    ).toBe(true);

    // A malformed tail fails the whole read even after the narration field parsed.
    for (const tail of [0x00, 0x80]) {
      expect(isClaudeNarrationSignature(toBase64([...narration, tail]))).toBe(false);
    }
  });

  it("rejects decodable bytes that carry no narration metadata", () => {
    for (const signature of ["AA==", toBase64([]), "  "]) {
      expect(isClaudeNarrationSignature(signature)).toBe(false);
    }
  });

  it("accepts the forgiving Base64 forms the reference atob accepts", () => {
    const encoded = syntheticClaudeSignature("narration");
    expect(isClaudeNarrationSignature(encoded.replace(/=+$/, ""))).toBe(true);
    expect(isClaudeNarrationSignature(`${encoded.slice(0, 4)}\n ${encoded.slice(4)}`)).toBe(true);
  });
});

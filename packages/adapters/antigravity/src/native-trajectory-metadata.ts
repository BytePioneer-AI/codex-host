const DEFAULT_CLI_PROJECT_ID = "default-cli-project";

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function decodeVarint(buffer: Uint8Array, start: number): [bigint, number] | null {
  let value = 0n;
  for (let index = 0; index < 10; index++) {
    const byte = buffer[start + index];
    if (byte === undefined || (index === 9 && byte > 1)) return null;
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return [value, start + index + 1];
  }
  return null;
}

function encodeLengthDelimited(fieldNumber: number, payload: Uint8Array): Buffer {
  return Buffer.concat([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(payload.length),
    Buffer.from(payload),
  ]);
}

export function minimalTrajectoryMetadataBlob(
  cascadeId: string,
  projectId = DEFAULT_CLI_PROJECT_ID,
): Buffer {
  return Buffer.concat([
    encodeLengthDelimited(6, Buffer.from(cascadeId, "utf8")),
    encodeLengthDelimited(18, Buffer.from(projectId, "utf8")),
  ]);
}

export function minimalRawSummaryBlob(trajectoryId: string, metadataBlob: Uint8Array): Buffer {
  return Buffer.concat([
    encodeLengthDelimited(4, Buffer.from(trajectoryId, "utf8")),
    Buffer.from([0x28, 0x01]),
    encodeLengthDelimited(17, metadataBlob),
    Buffer.from([0xb0, 0x01, 0x04]),
  ]);
}

/** Preserve non-identity field bytes; unreadable metadata must not become a minimal blob. */
export function rewriteTrajectoryMetadataCascadeId(
  blob: Uint8Array,
  cascadeId: string,
): Buffer | null {
  const chunks: Buffer[] = [];
  let offset = 0;
  let wroteCascadeId = false;
  let hasProjectId = false;
  while (offset < blob.length) {
    const fieldStart = offset;
    const tagParsed = decodeVarint(blob, offset);
    if (!tagParsed) return null;
    const [tag, afterTag] = tagParsed;
    if (tag < 8n || tag > 0xffffffffn) return null;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber === 6 && wireType !== 2) return null;
    offset = afterTag;
    if (wireType === 0) {
      const valParsed = decodeVarint(blob, offset);
      if (!valParsed) return null;
      offset = valParsed[1];
    } else if (wireType === 1) {
      if (offset + 8 > blob.length) return null;
      offset += 8;
    } else if (wireType === 2) {
      const lenParsed = decodeVarint(blob, offset);
      if (!lenParsed) return null;
      const [length, afterLen] = lenParsed;
      if (length > BigInt(blob.length - afterLen)) return null;
      offset = afterLen + Number(length);
      if (fieldNumber === 6) {
        if (!wroteCascadeId) {
          chunks.push(encodeLengthDelimited(6, Buffer.from(cascadeId, "utf8")));
          wroteCascadeId = true;
        }
        continue;
      }
      if (fieldNumber === 18) hasProjectId = true;
    } else if (wireType === 5) {
      if (offset + 4 > blob.length) return null;
      offset += 4;
    } else {
      return null;
    }
    chunks.push(Buffer.from(blob.subarray(fieldStart, offset)));
  }
  if (!wroteCascadeId) {
    chunks.push(encodeLengthDelimited(6, Buffer.from(cascadeId, "utf8")));
  }
  if (!hasProjectId) {
    chunks.push(encodeLengthDelimited(18, Buffer.from(DEFAULT_CLI_PROJECT_ID, "utf8")));
  }
  return Buffer.concat(chunks);
}

export function decodeVarint(buffer: Uint8Array, start: number): [bigint, number] | null {
  let value = 0n;
  for (let index = 0; index < 10; index++) {
    const byte = buffer[start + index];
    if (byte === undefined || (index === 9 && byte > 1)) return null;
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return [value, start + index + 1];
  }
  return null;
}

export interface ProtoField {
  number: number;
  wire: number;
  value: bigint | Uint8Array;
}

/** Decode bounded wire values without interpreting unknown message fields. */
export function readProtoFields(blob: Uint8Array): ProtoField[] | null {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < blob.length) {
    if (fields.length >= 10_000) return null;
    const tag = decodeVarint(blob, offset);
    if (!tag || tag[0] < 8n || tag[0] > 0xffffffffn) return null;
    offset = tag[1];
    const number = Number(tag[0] >> 3n);
    const wire = Number(tag[0] & 7n);
    if (wire === 0) {
      const value = decodeVarint(blob, offset);
      if (!value) return null;
      fields.push({ number, wire, value: value[0] });
      offset = value[1];
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (offset + length > blob.length) return null;
      fields.push({ number, wire, value: blob.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 2) {
      const length = decodeVarint(blob, offset);
      if (!length || length[0] > BigInt(blob.length - length[1])) return null;
      offset = length[1];
      const end = offset + Number(length[0]);
      fields.push({ number, wire, value: blob.subarray(offset, end) });
      offset = end;
    } else return null;
  }
  return fields;
}

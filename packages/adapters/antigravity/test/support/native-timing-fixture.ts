import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function varint(value: bigint | number): Buffer {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(bytes);
}
export function integer(field: number, value: number | bigint): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}
export function bytes(field: number, value: Uint8Array): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}
export function nanoseconds(value: bigint): Buffer {
  return Buffer.concat([integer(1, value / 1_000_000_000n), integer(2, value % 1_000_000_000n)]);
}
const time = (milliseconds: number) => nanoseconds(BigInt(milliseconds) * 1_000_000n);

export interface NativeTimingFixture {
  step: number;
  indices?: number[];
  input?: number;
  cached?: number;
  output?: number;
  created?: number;
  started?: number;
  completed?: number;
  streamDuration?: number;
  ttft?: number;
  retries?: number;
  attempts?: number;
  sourceSession?: string;
}
export async function writeNativeTimingDatabase(
  home: string,
  fixtures: NativeTimingFixture[],
  session = "session",
): Promise<string> {
  const file = path.join(home, ".gemini/antigravity-cli/conversations", `${session}.db`);
  await mkdir(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    database.exec(
      "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, metadata BLOB); CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)",
    );
    fixtures.forEach((fixture, index) => {
      const { step, created = 1000, started = 3000, completed = 5000 } = fixture;
      const usage = Buffer.concat([
        integer(2, fixture.input ?? 100),
        integer(3, fixture.output ?? 20),
        integer(5, fixture.cached ?? 50),
      ]);
      const metadata = Buffer.concat([
        bytes(1, time(created)),
        bytes(6, time(started)),
        bytes(7, time(completed)),
        bytes(8, time(completed + 60000)),
        bytes(9, usage),
        bytes(
          20,
          Buffer.concat([
            integer(2, step),
            integer(3, index),
            bytes(4, Buffer.from(fixture.sourceSession ?? session)),
          ]),
        ),
      ]);
      const chat = Buffer.concat([
        bytes(4, usage),
        bytes(11, time(fixture.ttft ?? started - created)),
        bytes(12, time(fixture.streamDuration ?? completed - started)),
        integer(14, fixture.retries ?? 0),
        ...Array.from({ length: fixture.attempts ?? 1 }, () => bytes(17, Buffer.alloc(0))),
      ]);
      const generator = Buffer.concat([
        bytes(1, chat),
        bytes(2, Buffer.concat((fixture.indices ?? [step, step + 1]).map(varint))),
      ]);
      database.prepare("INSERT OR REPLACE INTO steps VALUES (?, ?)").run(step, metadata);
      database.prepare("INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)").run(index, generator);
    });
  } finally {
    database.close();
  }
  return file;
}

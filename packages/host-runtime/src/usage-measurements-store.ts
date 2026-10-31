import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  usageMeasurementsSchema,
  type UsageMeasurementsSnapshot,
} from "@codexhost/shared-contracts";

const fields = ["outputTokensPerSecond", "timeToFirstOutputMs"] as const;
type Field = (typeof fields)[number];
export type UsageMeasurements = Partial<Record<Field, number>>;
export type StoredUsageMeasurements = UsageMeasurementsSnapshot;
interface BufferedSnapshot {
  values: StoredUsageMeasurements;
  revision: number;
  dirty: boolean;
  loaded?: Promise<void>;
}
// Several native Desktop connections may observe the same Thread in one Host process.
const writes = new Map<string, Promise<void>>();

/** Latest native-session display snapshot. record() is memory-only; no timers or append writes. */
export class UsageMeasurementsStore {
  private readonly snapshots = new Map<string, BufferedSnapshot>();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly directory: string,
    private readonly diagnose: (error: unknown) => void,
  ) {}
  private file(scope: string, sessionId: string): string {
    return join(
      this.directory,
      "usage-measurements-v1",
      createHash("sha256")
        .update(JSON.stringify([scope, sessionId]))
        .digest("hex") + ".json",
    );
  }
  private state(file: string): BufferedSnapshot {
    let state = this.snapshots.get(file);
    if (!state) {
      state = { values: {}, revision: 0, dirty: false };
      this.snapshots.set(file, state);
    }
    return state;
  }
  private merge(target: StoredUsageMeasurements, source: StoredUsageMeasurements): void {
    for (const field of fields) {
      const value = source[field];
      if (value && (!target[field] || value.at > target[field].at)) target[field] = value;
    }
  }
  private async disk(file: string): Promise<StoredUsageMeasurements | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const document = JSON.parse(raw);
      if (document?.version !== 1) throw new Error("Invalid usage measurement snapshot");
      return usageMeasurementsSchema.parse(document.values);
    } catch (error) {
      // This is a display cache: ignore corrupt facts and let a later real measurement repair it.
      this.diagnose(error);
      return {};
    }
  }
  private async legacy(file: string): Promise<StoredUsageMeasurements> {
    const values: StoredUsageMeasurements = {};
    const stream = createReadStream(file + "l");
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (line.length > 4096) continue;
        try {
          const entry = JSON.parse(line);
          if (entry?.version !== 1) continue;
          for (const field of fields) {
            if (entry.values?.[field] === undefined) continue;
            const parsed = usageMeasurementsSchema.safeParse({
              [field]: { value: entry.values[field], turnId: entry.turnId, at: entry.at },
            });
            if (parsed.success) this.merge(values, parsed.data);
          }
        } catch {
          /* Ignore an incomplete legacy tail. */
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.diagnose(error);
    } finally {
      stream.destroy();
    }
    return values;
  }
  private load(file: string, state: BufferedSnapshot): Promise<void> {
    return (state.loaded ??= (async () => {
      const disk = await this.disk(file);
      const values = disk ?? (await this.legacy(file));
      this.merge(state.values, values);
      // Compact a legacy log at the next normal flush, never during a read.
      if (!disk && Object.keys(values).length) state.dirty = true;
    })().catch((error) => {
      delete state.loaded;
      throw error;
    }));
  }
  record(
    scope: string,
    sessionId: string,
    turnId: string,
    at: number,
    values: UsageMeasurements,
  ): void {
    if (this.closed) return;
    const state = this.state(this.file(scope, sessionId));
    for (const field of fields) {
      if (values[field] === undefined) continue;
      const parsed = usageMeasurementsSchema.safeParse({
        [field]: { value: values[field], turnId, at },
      });
      if (!parsed.success) continue;
      const next = parsed.data[field],
        prior = state.values[field];
      if (
        !next ||
        (prior && (prior.at > at || (prior.turnId === turnId && prior.value === next.value)))
      )
        continue;
      state.values[field] = next;
      state.revision++;
      state.dirty = true;
    }
  }
  flush(scope: string, sessionId: string): Promise<void> {
    return this.flushFile(this.file(scope, sessionId));
  }
  private flushFile(file: string): Promise<void> {
    const state = this.snapshots.get(file);
    if (!state?.dirty) return Promise.resolve();
    const revision = state.revision;
    const captured = structuredClone(state.values);
    const previous = writes.get(file) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        if (!state.dirty) return;
        const disk = await this.disk(file);
        this.merge(captured, disk ?? (await this.legacy(file)));
        const values = usageMeasurementsSchema.parse(captured);
        if (JSON.stringify(disk) !== JSON.stringify(values)) {
          await mkdir(join(this.directory, "usage-measurements-v1"), {
            recursive: true,
            mode: 0o700,
          });
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify({ version: 1, values }) + "\n", {
              flag: "wx",
              mode: 0o600,
            });
            await rename(temporary, file);
          } finally {
            await rm(temporary, { force: true });
          }
        }
        this.merge(state.values, values);
        if (state.revision === revision) state.dirty = false;
        await rm(file + "l", { force: true });
      })
      .catch((error) => {
        this.diagnose(error);
      })
      .finally(() => {
        this.pending.delete(task);
        if (writes.get(file) === task) writes.delete(file);
      });
    writes.set(file, task);
    this.pending.add(task);
    return task;
  }
  async read(
    scope: string,
    sessionId: string,
    retainedTurns: ReadonlySet<string>,
  ): Promise<StoredUsageMeasurements> {
    const file = this.file(scope, sessionId),
      state = this.state(file);
    try {
      if (!state.loaded) await this.load(file, state);
      else {
        const latest = await this.disk(file);
        if (latest) this.merge(state.values, latest);
      }
    } catch (error) {
      this.diagnose(error);
      return {};
    }
    return structuredClone(
      Object.fromEntries(
        Object.entries(state.values).filter(
          ([, value]) => value && retainedTurns.has(value.turnId),
        ),
      ),
    );
  }
  close(): Promise<void> {
    this.closed = true;
    return (this.closing ??= (async () => {
      await Promise.all(this.pending);
      await Promise.all([...this.snapshots.keys()].map((file) => this.flushFile(file)));
    })());
  }
}

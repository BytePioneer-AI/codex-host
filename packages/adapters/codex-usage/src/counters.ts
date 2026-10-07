/*!
 * Codex counter reconciliation across rollout segments, normalizing the two
 * native counter domains into per-request usage records.
 *
 * Counter reconciliation logic derived from yetone/magpie
 * (https://github.com/yetone/magpie), internal/sessions/codex_usage.go.
 * MIT License — Copyright (c) 2026 yetone
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Two native counter domains coexist: legacy token_count omits compactions,
// token_usage_record's thread_token_usage includes them. Never compare them raw.
export interface Usage {
  values: number[];
  known: number;
}
const fields = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "reasoning_output_tokens",
] as const;
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function usage(value: unknown): Usage | null {
  const row = object(value);
  if (!row) return null;
  const result: Usage = { values: [], known: 0 };
  for (const [i, field] of fields.entries()) {
    const n = row[field];
    if (n !== undefined && n !== null) {
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
      result.known |= 1 << i;
    }
    result.values.push(typeof n === "number" ? n : 0);
  }
  return (result.known & 3) === 3 && valid(result) ? result : null;
}
const zero = (): Usage => ({ values: [0, 0, 0, 0, 0], known: 31 });
const val = (u: Usage, i: number): number => u.values[i] ?? 0;
const valid = (u: Usage): boolean =>
  u.values.every((n) => Number.isSafeInteger(n) && n >= 0) &&
  val(u, 2) + val(u, 3) <= val(u, 0) &&
  val(u, 4) <= val(u, 1);
const equal = (a: Usage, b: Usage): boolean => a.values.every((n, i) => n === val(b, i));
const covers = (a: Usage, b: Usage): boolean => a.values.every((n, i) => n >= val(b, i));
const minus = (a: Usage, b: Usage): Usage => ({
  values: a.values.map((n, i) => n - val(b, i)),
  known: a.known & b.known,
});
const plus = (a: Usage, b: Usage): Usage => ({
  values: a.values.map((n, i) => n + val(b, i)),
  known: a.known & b.known,
});
const isZero = (a: Usage): boolean => a.values.every((n) => n === 0);
const matches = (a: Usage, b: Usage): boolean =>
  (a.known & b.known & 3) === 3 &&
  a.values.every((n, i) => !(a.known & b.known & (1 << i)) || n === val(b, i));

export interface Contribution {
  response: string;
  session: string;
  thread: string;
  turn: string;
  model: string;
  at: number;
  updated: number;
  epoch: number;
  usage: Usage;
  total: Usage | null;
  countTotal: Usage | null;
  countEpoch: number;
  expected: Usage | null;
  compaction: boolean;
}
interface CounterBase {
  session: string;
  epoch: number;
  at: number;
  previousAt: number;
  base: Usage;
  start: Usage;
  confirmed: boolean;
}
function checkpoint(v: Contribution): [Usage | null, number] {
  return v.countTotal ? [v.countTotal, v.countEpoch] : [v.expected ?? v.total, v.epoch];
}
function key(v: Contribution): string {
  const [total, epoch] = checkpoint(v);
  return total
    ? JSON.stringify([
        v.session,
        epoch,
        val(total, 0),
        val(total, 1),
        val(v.usage, 0),
        val(v.usage, 1),
      ])
    : "";
}
function sameInterval(a: Contribution, b: Contribution): boolean {
  const [at, ae] = checkpoint(a),
    [bt, be] = checkpoint(b);
  return (
    !a.compaction &&
    !b.compaction &&
    ae === be &&
    a.session === b.session &&
    (!a.turn || !b.turn || a.turn === b.turn) &&
    !!at &&
    !!bt &&
    matches(at, bt) &&
    matches(a.usage, b.usage)
  );
}

/** One thread's ordered observations, including resumed segments. No I/O or pricing. */
export class CodexCounters {
  readonly entries: Contribution[] = [];
  readonly #responses = new Map<string, number>();
  readonly #intervals = new Map<string, Set<number>>();
  readonly #compactions = new Map<string, Contribution>();
  readonly #models = new Map<string, string>();
  readonly #bases: CounterBase[] = [];
  #pending = -1;
  #high: Usage | null = null;
  #highAt = 0;
  #epoch = 0;
  #session = "";
  #turn = "";
  #snapshotAt = 0;
  #snapshotThread = "";
  #snapshotTotal: Usage | null = null;
  #snapshotOffset: Usage | null = null;

  boundary(): void {
    this.#pending = -1;
  }
  context(session: string, turn: string, model: string): void {
    if (turn && turn !== this.#turn) this.boundary();
    if (session) this.#session = session;
    if (turn) this.#turn = turn;
    if (model && this.#turn) this.#models.set(this.#turn, model);
  }
  snapshot(at: number, thread: string, payload: Record<string, unknown>): void {
    if (
      payload.history_mode === "paginated" &&
      !payload.history_base &&
      typeof payload.subagent_history_start_ordinal === "number" &&
      payload.subagent_history_start_ordinal > 0
    ) {
      this.#snapshotAt = at;
      this.#snapshotThread = thread;
    }
  }
  #align(at: number, total: Usage, last: Usage | null): void {
    const active = this.#snapshotThread;
    this.#snapshotThread = "";
    if (
      !active ||
      !this.#snapshotTotal ||
      this.#high ||
      at !== this.#snapshotAt ||
      !last ||
      last.known !== 31 ||
      !isZero(last) ||
      total.known !== 31 ||
      this.#snapshotTotal.known !== 31 ||
      !covers(this.#snapshotTotal, total) ||
      this.entries.some((v) => !v.compaction || v.at !== at)
    )
      return;
    let offset = minus(this.#snapshotTotal, total);
    for (const c of this.#compactions.values()) {
      if (
        c.session !== this.#session ||
        c.at !== at ||
        c.usage.known !== 31 ||
        !covers(offset, c.usage)
      )
        return;
      offset = minus(offset, c.usage);
    }
    this.#snapshotOffset = offset;
  }
  #project(v: Contribution): [Usage | null, number] {
    if (!v.total || v.compaction) return [null, v.epoch];
    let offset =
      this.#snapshotOffset &&
      this.#snapshotTotal &&
      v.at >= this.#snapshotAt &&
      covers(v.total, this.#snapshotTotal)
        ? this.#snapshotOffset
        : zero();
    for (const c of this.#compactions.values()) {
      if (c.session !== v.session || v.at < c.at || (c.total && !covers(v.total, c.total)))
        continue;
      offset = plus(offset, c.usage);
    }
    if (!covers(v.total, offset)) return [null, v.epoch];
    let total = minus(v.total, offset),
      epoch = v.epoch;
    let base: Usage | null = null;
    for (const b of this.#bases) {
      if (b.session !== v.session) continue;
      const first =
        matches(total, b.start) && matches(v.usage, minus(b.start, b.base)) && v.at <= b.at;
      if (covers(total, b.start) && (b.confirmed || first)) {
        base = b.base;
        epoch = b.epoch;
      } else if (v.at <= b.previousAt) epoch = Math.min(epoch, b.epoch - 1);
    }
    if (base) total = minus(total, base);
    return isZero(offset) && !base ? [null, epoch] : [total, epoch];
  }
  #confirm(v: Contribution): void {
    if (!v.countTotal || !v.expected || !matches(v.countTotal, v.expected)) return;
    for (const b of this.#bases)
      if (b.session === v.session && b.epoch === v.countEpoch) b.confirmed = true;
  }
  #index(i: number, v: Contribution): void {
    const k = key(v);
    if (!k) return;
    const indices = this.#intervals.get(k) ?? new Set<number>();
    indices.add(i);
    this.#intervals.set(k, indices);
  }
  #save(i: number, v: Contribution): number {
    this.entries[i] = v;
    this.#index(i, v);
    return i;
  }
  #get(i: number): Contribution {
    const entry = this.entries[i];
    if (!entry) throw new Error("Invalid Codex counter index");
    return entry;
  }
  #advance(at: number, total: Usage): void {
    if (!this.#high || covers(total, this.#high)) {
      if (!this.#high || at > this.#highAt) this.#highAt = at;
      this.#high = total;
    }
  }
  #entry(at: number, model: string, amount: Usage, total: Usage | null): Contribution {
    return {
      response: "",
      session: this.#session,
      thread: "",
      turn: this.#turn,
      model: this.#models.get(this.#turn) || model,
      at,
      updated: at,
      epoch: this.#epoch,
      usage: amount,
      total,
      countTotal: null,
      countEpoch: 0,
      expected: null,
      compaction: false,
    };
  }

  record(at: number, model: string, row: Record<string, unknown>, compact = false): void {
    const amount = usage(row.usage);
    if (!amount || typeof row.response_id !== "string" || !row.response_id || !at) return;
    const v = this.#entry(at, model, amount, usage(row.thread_token_usage));
    v.response = row.response_id;
    v.session =
      typeof row.session_id === "string" && row.session_id ? row.session_id : this.#session;
    v.thread = typeof row.thread_id === "string" ? row.thread_id : "";
    v.turn = typeof row.turn_id === "string" && row.turn_id ? row.turn_id : this.#turn;
    v.model = this.#models.get(v.turn) || model;
    v.compaction = compact;
    const responseKey = `${v.session}\0${v.response}`;
    if (compact && this.#compactions.has(responseKey)) return;
    const existing = this.#responses.get(responseKey);
    if (compact && existing !== undefined) {
      const old = this.#get(existing);
      if (!equal(old.usage, amount)) return;
      const updated = { ...old, compaction: true };
      this.#save(existing, updated);
      this.#compactions.set(responseKey, updated);
      this.#noteSnapshot(updated);
      return;
    }
    const i = this.#record(v, responseKey);
    if (compact && i !== null) {
      const saved = this.#get(i);
      this.#compactions.set(responseKey, saved);
      this.#noteSnapshot(saved);
    }
  }
  #noteSnapshot(v: Contribution): void {
    if (
      this.#snapshotThread &&
      v.thread === this.#snapshotThread &&
      v.at === this.#snapshotAt &&
      v.total &&
      this.#compactions.size === 1
    )
      this.#snapshotTotal = v.total;
  }
  #record(v: Contribution, responseKey: string): number | null {
    const pending = this.#pending;
    this.boundary();
    [v.expected, v.epoch] = this.#project(v);
    const existing = this.#responses.get(responseKey);
    if (existing !== undefined) {
      const old = this.#get(existing);
      if (old.turn && v.turn && old.turn !== v.turn) return null;
      if (v.updated <= old.updated) return null;
      if (
        equal(old.usage, v.usage) &&
        old.usage.known === v.usage.known &&
        old.model === v.model &&
        !(old.total === null && v.total !== null)
      ) {
        return this.#save(existing, { ...old, updated: v.updated });
      }
      v.epoch = old.epoch;
      v.countTotal = old.countTotal;
      v.countEpoch = old.countEpoch;
      v.compaction = old.compaction;
      v.at = old.at;
      return this.#save(existing, v);
    }
    let match = -1;
    for (const i of this.#intervals.get(key(v)) ?? []) {
      const old = this.#get(i);
      if (!old.response && sameInterval(old, v)) {
        if (match >= 0) {
          match = -2;
          break;
        }
        match = i;
      }
    }
    if (match === -1 && !v.compaction && pending >= 0) {
      const old = this.#get(pending);
      if (
        !old.response &&
        old.turn === v.turn &&
        old.session === v.session &&
        matches(old.usage, v.usage)
      )
        match = pending;
    }
    if (match >= 0) {
      const old = this.#get(match);
      v.countTotal = old.total;
      v.countEpoch = old.epoch;
      this.#confirm(v);
      this.#responses.set(responseKey, match);
      return this.#save(match, v);
    }
    const i = this.entries.length;
    this.#responses.set(responseKey, i);
    if (!v.compaction) this.#pending = i;
    return this.#save(i, v);
  }

  count(at: number, model: string, total: Usage | null, last: Usage | null): void {
    if (!total || !at) return;
    this.#align(at, total, last);
    if (last && this.#responses.size) {
      const candidate = this.#entry(at, model, last, total);
      for (const i of this.#intervals.get(key(candidate)) ?? []) {
        const old = this.#get(i);
        if (!sameInterval(old, candidate)) continue;
        if (!old.response || old.countTotal) {
          if (this.#high && !covers(total, this.#high) && at > this.#highAt && matches(total, last))
            continue;
          return;
        }
        const v = { ...old };
        if (
          this.#high &&
          !isZero(this.#high) &&
          matches(total, last) &&
          !matches(total, this.#high) &&
          at > this.#highAt &&
          old.at > this.#highAt &&
          !old.expected &&
          old.total &&
          matches(old.total, total)
        ) {
          this.#epoch++;
          this.#high = null;
          v.epoch = this.#epoch;
        }
        v.countTotal = total;
        v.countEpoch = this.#epoch;
        this.#confirm(v);
        this.#save(i, v);
        this.#advance(at, total);
        return;
      }
    }
    if (last && this.#pending >= 0) {
      const old = this.#get(this.#pending);
      if (
        old.response &&
        !old.countTotal &&
        !old.compaction &&
        old.turn === this.#turn &&
        old.session === this.#session &&
        matches(old.usage, last)
      ) {
        this.#save(this.#pending, { ...old, countTotal: total, countEpoch: this.#epoch });
        this.boundary();
        this.#high = total;
        this.#highAt = at;
        return;
      }
    }
    this.boundary();
    let prev = this.#high,
      reset = false;
    const first =
      prev &&
      !isZero(prev) &&
      last &&
      !isZero(last) &&
      matches(total, last) &&
      !matches(total, prev);
    if (prev && (!covers(total, prev) || first)) {
      this.#epoch++;
      if (this.#responses.size && last && !isZero(last) && matches(total, last)) {
        const earlier = this.#bases.findLast((b) => b.session === this.#session && b.confirmed);
        const base = earlier ? plus(prev, earlier.base) : prev;
        this.#bases.push({
          session: this.#session,
          epoch: this.#epoch,
          at,
          previousAt: this.#highAt,
          base,
          start: plus(base, total),
          confirmed: false,
        });
        reset = true;
      }
      this.#high = null;
      prev = null;
    }
    const v = this.#entry(at, model, last ?? total, total);
    if (last) {
      if (reset) {
        let match = -1,
          projected: Contribution | null = null;
        for (const [i, old] of this.entries.entries()) {
          if (!old.response || old.countTotal || old.at > at) continue;
          const candidate = { ...old };
          [candidate.expected, candidate.epoch] = this.#project(candidate);
          if (sameInterval(candidate, v)) {
            if (match >= 0) {
              match = -2;
              break;
            }
            match = i;
            projected = candidate;
          }
        }
        if (match >= 0 && projected) {
          projected.countTotal = total;
          projected.countEpoch = this.#epoch;
          this.#confirm(projected);
          this.#save(match, projected);
          this.#advance(at, total);
          return;
        }
      }
      for (const i of this.#intervals.get(key(v)) ?? [])
        if (sameInterval(this.#get(i), v)) {
          this.#advance(at, total);
          return;
        }
    }
    if (prev && equal(total, prev)) return;
    this.#advance(at, total);
    if (prev) v.usage = minus(total, prev);
    if (isZero(v.usage) || !valid(v.usage)) return;
    this.#pending = this.#save(this.entries.length, v);
  }
}

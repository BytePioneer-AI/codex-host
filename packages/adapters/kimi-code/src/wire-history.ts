// Kimi keeps undone records in wire.jsonl. Only the active agent.switched
// ancestry belongs to the current conversation (base.line is one-based).
export function activeKimiWireRecords(content: string): Record<string, unknown>[] {
  const records: Array<Record<string, unknown> | undefined> = [];
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      records.push(undefined);
      continue;
    }
    try {
      const record: unknown = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error();
      records.push(record as Record<string, unknown>);
    } catch {
      if (index === lines.length - 1) break;
      throw new Error(`Malformed JSON in wire log at line ${index + 1}`);
    }
  }

  type Branch = { start: number; end: number; base?: { branch: string; line: number } };
  const branches = new Map<string, Branch>();
  let active = "main";
  let segment: Branch = { start: 0, end: records.length };
  branches.set(active, segment);
  for (const [index, record] of records.entries()) {
    if (record?.type !== "agent.switched") continue;
    const base = record.base as { branch?: unknown; line?: unknown } | undefined;
    if (
      typeof record.branch !== "string" ||
      branches.has(record.branch) ||
      typeof base?.branch !== "string" ||
      typeof base.line !== "number" ||
      !Number.isSafeInteger(base.line) ||
      base.line < 0 ||
      base.line > index
    )
      throw new Error(`Invalid Kimi branch at line ${index + 1}`);
    const parent = branches.get(base.branch);
    if (!parent || base.line < parent.start || base.line > parent.end)
      throw new Error(`Invalid Kimi branch base at line ${index + 1}`);
    segment.end = index;
    segment = {
      start: index + 1,
      end: records.length,
      base: { branch: base.branch, line: base.line },
    };
    active = record.branch;
    branches.set(active, segment);
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let end = records.length;
  for (;;) {
    const branch = branches.get(active);
    if (!branch) throw new Error(`Unknown Kimi branch: ${active}`);
    ranges.push({ start: branch.start, end });
    if (!branch.base) break;
    active = branch.base.branch;
    end = branch.base.line;
  }
  return ranges
    .reverse()
    .flatMap(({ start, end }) => records.slice(start, end))
    .filter(
      (record): record is Record<string, unknown> =>
        record !== undefined && record.type !== "agent.switched",
    );
}

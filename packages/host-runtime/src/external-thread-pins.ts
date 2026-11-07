import type { JsonObject } from "@codexhost/protocol-core";
import type { StoredSectionPlacementV1, StoredThreadRecordV1 } from "@codexhost/mapping-store";
import type { ExternalThreadRepository } from "./external-thread-repository.js";
import {
  findOfficialSection,
  mergeSectionOrder,
  moveThreadSection,
  sectionOrder,
  ThreadSectionError,
} from "./external-thread-sections.js";

/** Reserved built-in section in the native app-server protocol, verified by threadSection/list. */
export const PINNED_THREAD_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

type OfficialRequest = (method: string, params: JsonObject) => Promise<JsonObject>;

/** Workspace metadata projects membership from the same canonical placements without starting Codex. */
export function externalPinIds(
  records: readonly StoredThreadRecordV1[],
  placements: readonly StoredSectionPlacementV1[],
): string[] {
  const visible = new Set(
    records.filter((record) => !record.archived).map((record) => String(record.hostThreadId)),
  );
  return mergeSectionOrder(
    [],
    placements.filter((entry) => entry.section.id === PINNED_THREAD_SECTION_ID),
  ).filter((id) => visible.has(id));
}

/** External pins use the same durable section placements that Desktop reads. */
export class ExternalThreadPins {
  constructor(
    private readonly repository: ExternalThreadRepository,
    private readonly requestOfficial: OfficialRequest,
  ) {}

  async list(): Promise<string[]> {
    const [records, placements] = await Promise.all([
      this.repository.list(),
      this.repository.listSectionPlacements(),
    ]);
    const visible = new Set(externalPinIds(records, placements));
    if (visible.size === 0) return [];
    await findOfficialSection(this.requestOfficial, PINNED_THREAD_SECTION_ID);
    const order = await sectionOrder({
      sectionId: PINNED_THREAD_SECTION_ID,
      placements,
      requestOfficial: this.requestOfficial,
    });
    return order.filter((id) => visible.has(id));
  }

  async set(threadId: string, pinned: boolean): Promise<string[]> {
    const [records, placements] = await Promise.all([
      this.repository.list(),
      this.repository.listSectionPlacements(),
    ]);
    const record = records.find((entry) => entry.hostThreadId === threadId);
    if (!record) throw new ThreadSectionError("Thread is not owned by this external Host");
    if (pinned && record.archived)
      throw new ThreadSectionError("Archived Threads cannot be pinned");
    const current = placements.find((entry) => entry.hostThreadId === threadId);
    const isPinned = current?.section.id === PINNED_THREAD_SECTION_ID;
    if (isPinned === pinned) return this.list();

    // Resolve the actual native order so a new pin precedes official and External pins alike.
    await findOfficialSection(this.requestOfficial, PINNED_THREAD_SECTION_ID);
    const order = await sectionOrder({
      sectionId: PINNED_THREAD_SECTION_ID,
      placements,
      requestOfficial: this.requestOfficial,
    });
    const outcome = await moveThreadSection({
      move: {
        threadId,
        sectionId: pinned ? PINNED_THREAD_SECTION_ID : null,
        beforeThreadId: pinned ? (order[0] ?? null) : null,
      },
      movingExternal: true,
      externalThreadIds: new Set(records.map((entry) => String(entry.hostThreadId))),
      placements,
      requestOfficial: this.requestOfficial,
      savePlacements: (next) => this.repository.replaceSectionPlacements(next),
      now: new Date(),
    });
    if (outcome.kind !== "moved")
      throw new ThreadSectionError(
        outcome.kind === "error"
          ? String(outcome.error.message ?? "Native pin change failed")
          : "External pin change was not handled",
      );
    // Confirmation failure does not undo the durable write or cause it to be replayed.
    return this.list();
  }
}

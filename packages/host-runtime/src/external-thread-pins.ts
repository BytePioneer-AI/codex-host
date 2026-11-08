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

function pinError(response: JsonObject): string {
  return String((response.error as JsonObject).message ?? "Native pin change failed");
}

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

/** Official pins belong to app-server; External placements share Desktop's merged section order. */
export class ThreadPins {
  constructor(
    private readonly repository: ExternalThreadRepository,
    private readonly requestOfficial: OfficialRequest,
  ) {}

  async list(): Promise<string[]> {
    const [records, placements] = await Promise.all([
      this.repository.list(),
      this.repository.listSectionPlacements(),
    ]);
    const externalIds = new Set(placements.map((entry) => String(entry.hostThreadId)));
    const visible = new Set(externalPinIds(records, placements));
    await findOfficialSection(this.requestOfficial, PINNED_THREAD_SECTION_ID);
    const order = await sectionOrder({
      sectionId: PINNED_THREAD_SECTION_ID,
      placements,
      requestOfficial: this.requestOfficial,
    });
    return order.filter((id) => !externalIds.has(id) || visible.has(id));
  }

  async set(threadId: string, pinned: boolean): Promise<string[]> {
    const [records, placements] = await Promise.all([
      this.repository.list(),
      this.repository.listSectionPlacements(),
    ]);
    const record = records.find((entry) => entry.hostThreadId === threadId);
    let sectionId: string | null;
    let archived: boolean;
    if (record) {
      sectionId = placements.find((entry) => entry.hostThreadId === threadId)?.section.id ?? null;
      archived = record.archived;
    } else {
      const response = await this.requestOfficial("thread/read", { threadId, includeTurns: false });
      if (response.error) throw new ThreadSectionError(pinError(response));
      const thread = (response.result as JsonObject | undefined)?.thread as JsonObject | undefined;
      if (!thread) throw new ThreadSectionError("Native Thread read was not confirmed");
      const section = thread.section as JsonObject | null;
      sectionId = typeof section?.id === "string" ? section.id : null;
      archived = thread.archived === true;
    }
    if (pinned && archived) throw new ThreadSectionError("Archived Threads cannot be pinned");
    const isPinned = sectionId === PINNED_THREAD_SECTION_ID;
    if (isPinned === pinned) return this.list();

    // Resolve the actual native order so a new pin precedes official and External pins alike.
    await findOfficialSection(this.requestOfficial, PINNED_THREAD_SECTION_ID);
    const order = await sectionOrder({
      sectionId: PINNED_THREAD_SECTION_ID,
      placements,
      requestOfficial: this.requestOfficial,
    });
    const move = {
      threadId,
      sectionId: pinned ? PINNED_THREAD_SECTION_ID : null,
      beforeThreadId: pinned ? (order[0] ?? null) : null,
    };
    const outcome = await moveThreadSection({
      move,
      movingExternal: record !== undefined,
      externalThreadIds: new Set(records.map((entry) => String(entry.hostThreadId))),
      placements,
      requestOfficial: this.requestOfficial,
      savePlacements: (next) => this.repository.replaceSectionPlacements(next),
      now: new Date(),
    });
    if (outcome.kind === "forward") {
      const response = await this.requestOfficial("thread/section/move", move);
      if (response.error) throw new ThreadSectionError(pinError(response));
    } else if (outcome.kind === "error") {
      throw new ThreadSectionError(String(outcome.error.message ?? "Native pin change failed"));
    }
    // Confirmation failure does not undo the durable write or cause it to be replayed.
    return this.list();
  }
}

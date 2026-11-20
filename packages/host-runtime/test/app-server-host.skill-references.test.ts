import { expect, it, vi } from "vitest";
import { desktopSkillMentionPath, formatSkillReference } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  createFixture,
  requestId,
  startPiThread,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

const skill = { name: "eli5", path: "/skills/with spaces (copy)/SKILL.md" };
const carrier = `[@eli5](${desktopSkillMentionPath(skill)})`;
const canonical = formatSkillReference(skill);
const typed = `before ${carrier} middle ${carrier} after`;
const restored = `before ${canonical} middle ${canonical} after`;
const input = (text: string) => [{ type: "text", text }];

it("restores all inline Skills for Desktop start, active-Turn steer, queued writes and delivery", async () => {
  const fixture = createFixture();
  fixture.adapter.supportsSteer = true;
  try {
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Missing Fake Session");
    const execute = vi.spyOn(session, "execute");
    const request = async (id: number, method: string, params: JsonObject) => {
      writeRequest(fixture.desktopInput, { id, method, params: { threadId, ...params } });
      const response = await fixture.collector.waitFor((message) => requestId(message, id));
      expect(response).not.toHaveProperty("error");
      return response.result as JsonObject;
    };
    const started = await request(20, "turn/start", { input: input(typed) });
    const turnId = (started.turn as JsonObject).id as string;
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.start",
        input: input(restored),
      }),
    );
    await request(21, "turn/steer", {
      expectedTurnId: turnId,
      clientUserMessageId: "skill-steer",
      input: input(typed),
    });
    expect(session.steers[0]?.input).toEqual(input(restored));
    const queued = await request(22, "thread/queue/add", {
      clientUserMessageId: "skill-queue",
      input: input(typed),
      presentationInput: input(typed),
    });
    const item = queued.queuedSubmission as JsonObject;
    expect(item.input).toEqual([{ type: "text", text: restored, text_elements: [] }]);
    if (typeof item.id !== "string") throw new Error("Missing queued ID");
    await request(23, "thread/queue/update", {
      queuedSubmissionId: item.id,
      input: input(`edited ${typed}`),
    });
    const listed = await request(24, "thread/queue/list", {});
    expect(listed).toMatchObject({ data: [{ input: [{ text: `edited ${restored}` }] }] });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await vi.waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "turn.start",
          input: input(`edited ${restored}`),
        }),
      ),
    );
  } finally {
    await stopFixture(fixture);
  }
});

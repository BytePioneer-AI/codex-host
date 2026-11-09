/** Real Web attachment preparation -> real Host routing, with an in-memory fake Adapter. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { HarnessCommandInvocation } from "@codexhost/harness-adapter";
import {
  formatDelegationMentionLink,
  harnessCommandDescriptorSchema,
  hostItemIdSchema,
  restoreHarnessCommandMentions,
} from "@codexhost/shared-contracts";
import { harnessCommandReference } from "../../apps/web-ui/packages/client/ui-codexhost/src/client/harness-command-reference.ts";
import { ChFileInputs } from "../../packages/web-server/src/ch-file-inputs.ts";
import { WebFiles } from "../../packages/web-server/src/web-files.ts";
import { WebImages } from "../../packages/web-server/src/web-images.ts";
import { DataDir } from "../../packages/web-server/src/store.ts";
import {
  isExternalCommandCandidate,
  resolveExternalCommand,
} from "../../packages/host-runtime/src/external-command-routing.ts";
import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "../../packages/host-runtime/test/app-server-host-fixture.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const skill = harnessCommandDescriptorSchema.parse({
  id: "fake.skill",
  invocation: "/native-skill",
  label: "Native skill",
  kind: "skill",
  argumentMode: "text",
});
const delegation = formatDelegationMentionLink({ harnessId: "claude-code", label: "Claude" });
const body = "review  attached\tfile\n  keep indentation";

for (const attachment of ["none", "file", "image", "both"] as const)
  for (const withDelegation of [false, true])
    it(`routes a Web command through native execute: ${attachment}, delegation=${withDelegation}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "web-command-carrier-"));
      const fixture = createFixture();
      try {
        const threadId = await startPiThread(fixture);
        const session = fixture.adapter.sessions[0];
        if (!session) throw new Error("Missing fake session");
        const prompt = vi.spyOn(session, "execute");
        const execute = vi.fn(async ({ turnId }: HarnessCommandInvocation) => {
          session.publishEphemeralCommand(turnId, {
            type: "contextCompaction",
            itemId: hostItemIdSchema.parse("native-skill-item"),
          });
          return { ok: true as const, value: { turnId } };
        });
        session.commands = {
          list: async () => ({ ok: true, value: { commands: [skill] } }),
          execute,
        };
        const data = new DataDir(root),
          files = new WebFiles(data),
          images = new WebImages(data);
        const inputs = new ChFileInputs(files, images, async (id) => id);
        const reference = harnessCommandReference(skill.invocation);
        // Put the selection between argument text, as an inline menu pick can do.
        const request = withDelegation
          ? `${body} ${reference.ref} ${delegation}`
          : `${reference.ref} ${body}`;
        const attachments: unknown[] = [];
        if (attachment === "file" || attachment === "both") {
          const saved = await files.upload(
            threadId,
            (async function* () {
              yield Buffer.from("review these bytes");
            })(),
            "review.txt",
          );
          attachments.push({ type: "file", receiptId: saved.receiptId });
        }
        if (attachment === "image" || attachment === "both")
          attachments.push({ type: "image", mediaType: "image/png", data: png });
        const prepared = await inputs.prepare(threadId, [
          { type: "text", text: request },
          ...attachments,
        ]);
        const preparedText = prepared.map((part) => part.text).join("\n");
        const restored = restoreHarnessCommandMentions(preparedText);
        expect(isExternalCommandCandidate(restored)).toBe(true);
        const match = await resolveExternalCommand(session.commands, restored);
        expect(match?.descriptor.id).toBe(skill.id);
        expect(match?.arguments?.text).toContain(body);
        if (attachment !== "none") {
          expect(preparedText.startsWith("\n# Files mentioned by the user:")).toBe(true);
          // The old plain slash prefix reproduces the failure after the real preparation step.
          const old = await inputs.prepare(threadId, [
            { type: "text", text: `${skill.invocation} ${body}` },
            ...attachments,
          ]);
          expect(
            isExternalCommandCandidate(restoreHarnessCommandMentions(old[0]?.text ?? "")),
          ).toBe(false);
        }
        if (attachment === "file" || attachment === "both") {
          expect(restored).toContain("review.txt:");
          const path = /## review.txt: (.+)\n/u.exec(restored)?.[1];
          expect(path && readFileSync(path, "utf8")).toBe("review these bytes");
        }
        if (attachment === "image" || attachment === "both")
          expect(restored).toContain("Image attachment: true");
        if (withDelegation) expect(restored).toContain(delegation);
        writeRequest(fixture.desktopInput, {
          id: 20,
          method: "turn/start",
          params: { threadId, input: prepared },
        });
        const response = await fixture.collector.waitFor((message) => requestId(message, 20));
        expect(response).not.toHaveProperty("error");
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0]?.[0]).toMatchObject({
          commandId: skill.id,
          arguments: match?.arguments,
        });
        expect(prompt).not.toHaveBeenCalled();
      } finally {
        await stopFixture(fixture);
        rmSync(root, { recursive: true, force: true });
      }
    });

for (const mode of ["queue", "steer"] as const)
  it(`keeps native command routing after the existing ${mode} lifecycle with attachments`, async () => {
    const root = mkdtempSync(join(tmpdir(), "web-command-delivery-"));
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fake session");
      const previousTurn = await startPiTurn(fixture, threadId);
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/started", previousTurn),
      );
      const prompt = vi.spyOn(session, "execute");
      const execute = vi.fn(async ({ turnId }: HarnessCommandInvocation) => {
        session.publishEphemeralCommand(turnId, {
          type: "contextCompaction",
          itemId: hostItemIdSchema.parse("queued-skill-item"),
        });
        return { ok: true as const, value: { turnId } };
      });
      session.commands = {
        list: async () => ({ ok: true, value: { commands: [skill] } }),
        execute,
      };
      const data = new DataDir(root),
        files = new WebFiles(data);
      const saved = await files.upload(
        threadId,
        (async function* () {
          yield Buffer.from("queue attachment");
        })(),
        "queued.txt",
      );
      const prepared = await new ChFileInputs(files, new WebImages(data), async (id) => id).prepare(
        threadId,
        [
          {
            type: "text",
            text: `${harnessCommandReference(skill.invocation).ref} ${body} ${delegation}`,
          },
          { type: "file", receiptId: saved.receiptId },
        ],
      );
      if (mode === "steer") session.completeCancellationOnRequest();
      const response = await fixture.host.handleClientRequest(
        mode === "steer" ? "turn/steer" : "turn/start",
        {
          threadId,
          input: prepared,
          ...(mode === "steer" ? { expectedTurnId: previousTurn } : { delivery: "queue" }),
        },
      );
      expect(response).not.toHaveProperty("error");
      if (mode === "queue") {
        expect(execute).not.toHaveBeenCalled();
        session.succeedTurn();
      }
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(execute.mock.calls[0]?.[0].arguments?.text).toContain(body);
      expect(execute.mock.calls[0]?.[0].arguments?.text).toContain("queued.txt:");
      expect(execute.mock.calls[0]?.[0].arguments?.text).toContain(delegation);
      expect(prompt.mock.calls.map(([command]) => command.type)).not.toContain("turn.start");
    } finally {
      await stopFixture(fixture);
      rmSync(root, { recursive: true, force: true });
    }
  });

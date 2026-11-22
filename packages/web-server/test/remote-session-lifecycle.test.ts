import assert from "node:assert/strict";
import { it } from "node:test";
import { RemoteSessionError } from "@codexhost/desktop-control";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { EventHub } from "../src/transport.ts";

for (const retirement of ["removed", "replaced", "closed"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    it(`discards a late read ${outcome} after its Entry is ${retirement}`, async (t) => {
      const hostId = "remote-control:lifecycle";
      const id = remoteSessionId(hostId, "thread");
      let present = true;
      let hold = false;
      let revision = "old";
      const row = () => ({
        id: "thread",
        cwd: "/remote",
        name: revision,
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 2,
        status: { type: "idle" },
        turns: [],
      });
      const started = Promise.withResolvers<undefined>();
      const response = Promise.withResolvers<unknown>();
      t.after(() => response.resolve(undefined));
      const events = new EventHub("entry-lifecycle");
      const published: unknown[] = [];
      events.emit = (event, ...args) => published.push({ event, args });
      const cancellations: string[] = [];
      const invoke = events.invoke.bind(events);
      events.invoke = (...args) => {
        const pending = invoke(...args);
        const owner = revision;
        return {
          ...pending,
          cancel() {
            cancellations.push(owner);
            pending.cancel();
          },
        };
      };
      const snapshot = () => ({
        result: { thread: row() },
        epoch: revision,
        requests: [
          {
            id: revision,
            method: "item/commandExecution/requestApproval",
            params: { threadId: "thread", command: "fixture" },
          },
        ],
      });
      const remote = new RemoteSessions(events, async (operation) => {
        if (operation.kind === "hosts") return [{ hostId, online: true }];
        if (operation.kind === "list") return { data: present ? [row()] : [], nextCursor: null };
        if (operation.kind === "read") {
          if (hold) {
            hold = false;
            started.resolve(undefined);
            return response.promise;
          }
          return snapshot();
        }
        return {};
      });
      t.after(() => remote.close());
      const oldView = await remote.read(id);
      const oldProjection = JSON.stringify(oldView.log.projectionBaseline());
      const oldSnapshot = snapshot();
      hold = true;
      const reading = remote.read(id);
      const rejected = assert.rejects(reading, {
        code: retirement === "replaced" ? "remote/connection-changed" : "remote/not-found",
      });
      await started.promise;
      if (retirement === "closed") remote.close();
      else {
        present = false;
        await remote.refresh();
      }
      let newView;
      if (retirement === "replaced") {
        revision = "new";
        present = true;
        await remote.refresh();
        newView = await remote.read(id);
      }
      const newProjection = newView && JSON.stringify(newView.log.projectionBaseline());
      published.length = 0;
      cancellations.length = 0;
      if (outcome === "success") response.resolve(oldSnapshot);
      else response.reject(new RemoteSessionError(-32090, "retired read failed"));
      await rejected;
      assert.deepEqual(published, []);
      assert.deepEqual(cancellations, []);
      assert.equal(JSON.stringify(oldView.log.projectionBaseline()), oldProjection);
      if (newView) assert.equal(JSON.stringify(newView.log.projectionBaseline()), newProjection);
    });
  }
}

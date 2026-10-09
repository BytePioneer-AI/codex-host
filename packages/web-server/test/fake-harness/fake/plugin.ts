/**
 * Scriptable Harness for server integration tests. A turn's input text selects a script from
 * `globalThis.fakeHarnessScripts`; steps emit Host events, raise interactions, or wait for the
 * interaction response before continuing.
 */

type Step =
  | { event: Record<string, unknown> & { type: string } }
  | { interaction: Record<string, unknown> & { type: string; interactionId: string } }
  | { awaitResponse: string }
  | { awaitCancel: true };

declare global {
  var fakeHarnessScripts: Record<string, Step[]> | undefined;
  var fakeHarnessLog: Array<Record<string, unknown>> | undefined;
  var fakeHarnessHistory: Record<string, unknown[]> | undefined;
  var fakeHarnessSubagents: Record<string, unknown[]> | undefined;
}

class Channel {
  private values: unknown[] = [];
  private waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  private ended = false;
  readonly outputs = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<unknown>>((resolve) => this.waiters.push(resolve));
      },
    }),
  };
  emit(value: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value });
    else this.values.push(value);
  }
  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
}

let nextSession = 0;

class FakeSession {
  readonly harnessId = "fake";
  readonly capabilities = {
    configuration: { selectModel: true, selectThinkingOption: true, selectPermissionMode: true },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  };
  readonly initialUsage = null;
  readonly initialState: Record<string, unknown>;
  private readonly channel = new Channel();
  readonly outputs = this.channel.outputs;
  private responses = new Map<string, (value: unknown) => void>();
  private cancel: (() => void) | undefined;

  constructor(readonly nativeId: string) {
    this.initialState = {
      nativeRef: { harnessId: "fake", nativeSessionId: nativeId },
      effectiveModel: { id: "fake-model" },
      effectivePermissionModeId: "ask",
    };
  }

  private async play(turnId: string, steps: Step[]): Promise<void> {
    this.channel.emit({ kind: "event", event: { type: "turn.started", turnId } });
    for (const step of steps) {
      if ("event" in step) this.channel.emit({ kind: "event", event: { turnId, ...step.event } });
      else if ("interaction" in step)
        this.channel.emit({ kind: "interaction", interaction: { turnId, ...step.interaction } });
      else if ("awaitResponse" in step) {
        const response = await new Promise((resolve) =>
          this.responses.set(step.awaitResponse, resolve),
        );
        globalThis.fakeHarnessLog?.push({ responded: step.awaitResponse, response });
      } else {
        await new Promise<void>((resolve) => {
          this.cancel = resolve;
        });
        this.channel.emit({
          kind: "event",
          event: { type: "turn.completed", turnId, outcome: { status: "cancelled" } },
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async execute(command: Record<string, unknown> & { type: string }): Promise<unknown> {
    globalThis.fakeHarnessLog?.push({
      command: command.type,
      ...(command.type === "turn.start"
        ? { text: (command.input as Array<{ text: string }>)[0]?.text }
        : {}),
    });
    switch (command.type) {
      case "turn.start": {
        const text = (command.input as Array<{ text: string }>).map((part) => part.text).join("\n");
        const steps = globalThis.fakeHarnessScripts?.[text] ?? [
          {
            event: {
              type: "item.completed",
              snapshot: {
                item: {
                  type: "agentMessage",
                  itemId: `m-${String(Date.now())}`,
                  text: `echo: ${text}`,
                },
                outcome: { status: "succeeded" },
              },
            },
          },
          { event: { type: "turn.completed", outcome: { status: "succeeded" } } },
        ];
        void this.play(String(command.turnId), steps);
        return { ok: true, value: { turnId: command.turnId } };
      }
      case "turn.cancel":
        this.cancel?.();
        return { ok: true, value: { cancellationRequested: true } };
      case "interaction.respond": {
        const resolve = this.responses.get(String(command.interactionId));
        resolve?.(command.response);
        this.channel.emit({
          kind: "event",
          event: {
            type: "interaction.closed",
            interactionId: command.interactionId,
            reason: "responded",
          },
        });
        return { ok: true, value: { accepted: true } };
      }
      default:
        return { ok: true, value: { completed: true } };
    }
  }

  async readSnapshot(): Promise<unknown> {
    return { ok: true, value: { turns: globalThis.fakeHarnessHistory?.[this.nativeId] ?? [] } };
  }

  async close(): Promise<void> {
    this.channel.end();
  }
}

export function createHarnessAdapter(): unknown {
  return {
    harnessId: "fake",
    async inspect() {
      return {
        status: "ready",
        catalog: {
          models: [{ ref: { id: "fake-model" }, label: "Fake Model" }],
          defaultModel: { id: "fake-model" },
          thinkingOptions: [],
        },
        permissionModes: {
          modes: [
            { id: "ask", label: "Ask" },
            { id: "yolo", label: "Yolo" },
          ],
          defaultModeId: "ask",
        },
        capabilities: {
          configuration: {
            selectModel: true,
            selectThinkingOption: false,
            selectPermissionMode: true,
          },
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        },
      };
    },
    async open(input: { kind: string; nativeRef?: { nativeSessionId: string } }) {
      globalThis.fakeHarnessLog?.push({ open: input.kind });
      return {
        ok: true,
        value: new FakeSession(
          input.nativeRef?.nativeSessionId ?? `fake-native-${String(++nextSession)}`,
        ),
      };
    },
    sessionImport: {
      async listCandidates() {
        return {
          ok: true,
          value: Object.keys(globalThis.fakeHarnessHistory ?? {}).map((id, index) => ({
            nativeSessionId: id,
            title: `History ${id}`,
            updatedAt: 1_000_000 + index,
            cwd: process.env.FAKE_HARNESS_CWD ?? "/tmp",
            running: null,
          })),
        };
      },
      async resolveCandidate(id: string) {
        if (globalThis.fakeHarnessHistory?.[id] === undefined)
          return { ok: false, error: { code: "sessionNotFound", message: "missing" } };
        return {
          ok: true,
          value: {
            candidate: {
              nativeSessionId: id,
              title: `History ${id}`,
              updatedAt: 1_000_000,
              cwd: process.env.FAKE_HARNESS_CWD ?? "/tmp",
              running: null,
            },
            nativeRef: { harnessId: "fake", nativeSessionId: id },
          },
        };
      },
    },
    subagents: {
      async readSnapshot(input: { nativeSubagentId: string }) {
        return {
          ok: true,
          value: { turns: globalThis.fakeHarnessSubagents?.[input.nativeSubagentId] ?? [] },
        };
      },
    },
    async close() {},
  };
}

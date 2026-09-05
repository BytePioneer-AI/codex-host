export interface TurnAdjustmentManager {
  getConversation?(threadId: string): unknown;
  updateConversationState?(
    threadId: string,
    update: (state: Record<string, unknown>) => void,
  ): void;
}

type SendRequest = (method: string, parameters: unknown, options?: unknown) => unknown;

interface RendererTurnAdjustmentBridge {
  sendRequest: SendRequest;
  onNotification(method: string, parameters: unknown): void;
  dispose(): void;
}

/** Serialized into the Renderer: keep this function self-contained and browser-safe. */
export function createRendererTurnAdjustmentBridge(
  manager: TurnAdjustmentManager,
  send: SendRequest,
): RendererTurnAdjustmentBridge {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const turns = (state: unknown): Record<string, unknown>[] | null => {
    if (!record(state)) return null;
    if (record(state.turnHistory) && state.turnHistory.kind === "canonical") {
      const history = state.turnHistory.history;
      if (!record(history) || !Array.isArray(history.islands) || !record(history.entitiesByKey))
        return null;
      const result: Record<string, unknown>[] = [];
      for (const island of history.islands) {
        if (!record(island) || !Array.isArray(island.entries)) return null;
        for (const entry of island.entries) {
          if (!record(entry) || typeof entry.value !== "string") return null;
          const turn = history.entitiesByKey[entry.value];
          if (!record(turn)) return null;
          result.push(turn);
        }
      }
      return result;
    }
    return Array.isArray(state.turns) && state.turns.every(record) ? state.turns : null;
  };

  const pendingInputs = new Map<
    string,
    { threadId: string; turnId: string; input: unknown[]; clientId: string }
  >();
  let disposed = false;
  const restoreContinuationInput = (key: string): void => {
    const pending = pendingInputs.get(key);
    if (!pending) return;
    const target = turns(manager.getConversation?.(pending.threadId))?.find(
      (turn) => turn.turnId === pending.turnId,
    );
    if (!target || !record(target.params) || !Array.isArray(target.params.input)) return;
    manager.updateConversationState?.(pending.threadId, (state) => {
      const turn = turns(state)?.find((turn) => turn.turnId === pending.turnId);
      if (!turn || !record(turn.params) || !Array.isArray(turn.params.input)) return;
      // Server-initiated Turns receive visible userMessage items, but the stock
      // editor reads params.input. The client identity also preserves that input
      // when Desktop merges a later history page into its live Turn state.
      if (turn.params.input.length === 0) {
        turn.params.input = pending.input;
        turn.params.clientUserMessageId = pending.clientId;
      }
      pendingInputs.delete(key);
    });
  };

  const sendRequest: SendRequest = (method, parameters, options) => {
    if (method !== "turn/steer" || !record(parameters) || typeof parameters.threadId !== "string") {
      return send(method, parameters, options);
    }
    const threadId = parameters.threadId;
    return Promise.resolve(send("codexhost/thread/inspect", { threadId })).then(
      async (inspection) => {
        if (
          !record(inspection) ||
          inspection.owner !== "external" ||
          !record(inspection.activeTurns) ||
          inspection.activeTurns.steer === true ||
          inspection.activeTurns.interruptAndContinue !== true
        ) {
          return send(method, parameters, options);
        }
        const sourceTurn = turns(manager.getConversation?.(threadId))?.find(
          (turn) => turn.turnId === parameters.expectedTurnId && turn.status === "inProgress",
        );
        const clientId = parameters.clientUserMessageId;
        const item =
          typeof clientId === "string" && Array.isArray(sourceTurn?.items)
            ? sourceTurn.items.find(
                (item: unknown) =>
                  record(item) &&
                  item.type === "steeringUserMessage" &&
                  item.clientUserMessageId === clientId &&
                  item.serverUserMessageId == null &&
                  (item.status === "pending" || item.status === "accepted"),
              )
            : null;
        if (!record(item) || !manager.updateConversationState) {
          throw new Error(
            "Cannot adjust this execution: the Desktop pending message could not be identified",
          );
        }
        // Remove the optimistic steer before the old terminal can restore it as a queued follow-up.
        let detached = false;
        manager.updateConversationState(threadId, (state) => {
          const turn = turns(state)?.find(
            (turn) => turn.turnId === parameters.expectedTurnId && turn.status === "inProgress",
          );
          if (!turn || !Array.isArray(turn.items)) return;
          const index = turn.items.findIndex(
            (candidate: unknown) => record(candidate) && candidate.id === item.id,
          );
          if (index < 0) return;
          turn.items.splice(index, 1);
          detached = true;
        });
        if (!detached)
          throw new Error("The current execution ended before the adjustment was submitted");
        let response: unknown;
        try {
          response = await send("codexhost/turn/adjust", parameters, options);
        } catch (error) {
          // Restore the original item so the stock failure/outcome-unknown path retains restoreMessage.
          manager.updateConversationState(threadId, (state) => {
            const turn = turns(state)?.find((turn) => turn.turnId === parameters.expectedTurnId);
            if (
              turn &&
              Array.isArray(turn.items) &&
              !turn.items.some(
                (candidate: unknown) => record(candidate) && candidate.id === item.id,
              )
            ) {
              turn.items.push(item);
            }
          });
          throw error;
        }
        if (
          !disposed &&
          record(response) &&
          response.delivery === "interrupt-and-continue" &&
          response.previousTurnId === parameters.expectedTurnId &&
          typeof response.turnId === "string" &&
          typeof clientId === "string" &&
          Array.isArray(parameters.input)
        ) {
          const key = JSON.stringify([threadId, response.turnId]);
          pendingInputs.set(key, {
            threadId,
            turnId: response.turnId,
            input: structuredClone(parameters.input),
            clientId,
          });
          restoreContinuationInput(key);
        }
        return response;
      },
    );
  };

  return {
    sendRequest,
    onNotification(method, parameters) {
      if (!record(parameters) || typeof parameters.threadId !== "string") return;
      if (method === "thread/closed" || method === "thread/deleted") {
        for (const [key, pending] of pendingInputs) {
          if (pending.threadId === parameters.threadId) pendingInputs.delete(key);
        }
        return;
      }
      const turnId =
        (method === "turn/started" || method === "turn/completed") && record(parameters.turn)
          ? parameters.turn.id
          : method === "item/started" || method === "item/completed"
            ? parameters.turnId
            : null;
      if (typeof turnId === "string") {
        restoreContinuationInput(JSON.stringify([parameters.threadId, turnId]));
      }
    },
    dispose() {
      disposed = true;
      pendingInputs.clear();
    },
  };
}

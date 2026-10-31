// Adapted from karlorz/codex-host@07d8f010 (LGPL-3.0-only), without activity/timer RPCs.
import {
  THREAD_QUESTIONS_LIST_METHOD,
  THREAD_QUESTION_RESPOND_METHOD,
  threadQuestionsResultSchema,
  threadQuestionRespondResultSchema,
} from "@codexhost/shared-contracts";
import { createQuestionCard } from "./renderer-question-card.js";
import { isUnsupportedMethod, type RendererRequestOptions } from "./renderer-request-sender.js";

export interface QuestionContext {
  hostId: string;
  threadId: string;
  composer: Element;
  route: {
    sendRequest(method: string, params: unknown, options?: RendererRequestOptions): unknown;
  };
}
function same(a: QuestionContext | null, b: QuestionContext | null): boolean {
  return (
    a?.hostId === b?.hostId &&
    a?.threadId === b?.threadId &&
    a?.composer === b?.composer &&
    a?.route === b?.route
  );
}

/** Only the unambiguous visible external Composer can own a card. */
export function installRendererQuestions(
  window: Window,
  readContext: () => QuestionContext | null,
) {
  let disposed = false;
  let inFlight = false;
  let revision = 0;
  let context: QuestionContext | null = null;
  let card: ReturnType<typeof createQuestionCard> | null = null;
  let cardKey: string | null = null;
  const unsupported = new WeakSet<object>();
  const drafts = new Map<string, Record<string, string[]>>();
  const clear = (retain = true) => {
    if (retain && card && cardKey) {
      drafts.set(cardKey, card.readAnswers());
      const oldest = drafts.keys().next().value;
      if (drafts.size > 50 && oldest !== undefined) drafts.delete(oldest);
    }
    card?.dispose();
    card = null;
    cardKey = null;
  };
  const refresh = async () => {
    if (disposed) return;
    const next = readContext();
    if (!same(context, next)) {
      clear();
      context = next;
      revision++;
    }
    const current = context;
    if (!current || inFlight || unsupported.has(current.route)) return;
    const startedRevision = revision;
    inFlight = true;
    try {
      const raw = await current.route.sendRequest(
        THREAD_QUESTIONS_LIST_METHOD,
        { threadId: current.threadId },
        { priority: "background", timeoutMs: 5000 },
      );
      if (disposed || revision !== startedRevision || !same(current, readContext())) return;
      const question = threadQuestionsResultSchema.parse(raw).questions[0];
      if (!question) {
        if (cardKey) drafts.delete(cardKey);
        clear(false);
        return;
      }
      const key = JSON.stringify([
        current.hostId,
        current.threadId,
        question.turnId,
        question.interactionId,
      ]);
      if (cardKey === key && card?.root.isConnected) return;
      clear(cardKey === key);
      cardKey = key;
      card = createQuestionCard(
        current.composer.ownerDocument,
        question,
        async (answers, cancelled) => {
          if (disposed || !same(current, readContext()) || cardKey !== key)
            throw new Error("Question owner changed");
          const raw = await current.route.sendRequest(
            THREAD_QUESTION_RESPOND_METHOD,
            {
              threadId: current.threadId,
              turnId: question.turnId,
              interactionId: question.interactionId,
              answers,
              cancelled,
            },
            { priority: "interactive", timeoutMs: 10000 },
          );
          threadQuestionRespondResultSchema.parse(raw);
          drafts.delete(key);
          if (same(current, context)) {
            // An older in-flight list must not resurrect an already answered card.
            revision++;
            if (cardKey === key) clear(false);
          }
        },
        drafts.get(key),
      );
      // Keep question editors outside native Composer discovery and submission handlers.
      current.composer.before(card.root);
    } catch (error) {
      if (isUnsupportedMethod(error, THREAD_QUESTIONS_LIST_METHOD)) unsupported.add(current.route);
      if (revision === startedRevision && same(current, context)) clear();
    } finally {
      inFlight = false;
    }
  };
  const timer = window.setInterval(() => {
    void refresh();
  }, 750);
  void refresh();
  return {
    refresh,
    refreshContext() {
      // Streaming DOM mutations must not turn the background poll into a request per token.
      if (!same(context, readContext()) || (card && !card.root.isConnected)) void refresh();
    },
    dispose() {
      disposed = true;
      window.clearInterval(timer);
      clear(false);
      drafts.clear();
    },
  };
}

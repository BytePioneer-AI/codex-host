import type { Context } from "@deepseek-ai/cordis";
import { composeAnnotatedMessage } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import { SessionInputShell } from "../src/client/input/facade.ts";
import { restoreQueuedTextAndAnnotations } from "../src/client/queue/edit-queue.ts";

function createShell(options?: {
  onSubmit?: (args: { text: string; onRequestId?: (requestId: string) => void }) => void;
}): SessionInputShell {
  return new SessionInputShell({
    actx: {} as Context,
    defaultSink: async (text, _attachmentIds, _mode, _signal, onRequestId) => {
      options?.onSubmit?.({ text, ...(onRequestId === undefined ? {} : { onRequestId }) });
      return { kind: "success" };
    },
    commandAttachments: {
      serialize: async () => [],
      release: () => {},
      unsupportedNotice: (token) => `unsupported ${token}`,
    },
  });
}

describe("SessionInputShell response annotations", () => {
  it("attaches annotations with focus:'end' even while editor root is unmounted/non-editable, and rejects after dispose", () => {
    const shell = createShell();
    try {
      // No root element attached -> canInsertReferences() is false, matching transient resync/overlay states.
      expect(shell.editor.getRootElement()).toBeNull();
      const id = shell.actions.addResponseAnnotation(
        {
          text: "selected quote",
          annotation: "clarify this",
          anchor: {
            answerKey: "answer-1",
            startOffset: 10,
            endOffset: 24,
            quote: "selected quote",
            prefix: "before ",
            suffix: " after",
          },
        },
        { focus: "end" },
      );

      expect(id).toBeDefined();
      expect(shell.state.getSnapshot().responseAnnotations).toEqual([
        {
          id,
          text: "selected quote",
          annotation: "clarify this",
          anchor: {
            answerKey: "answer-1",
            startOffset: 10,
            endOffset: 24,
            quote: "selected quote",
            prefix: "before ",
            suffix: " after",
          },
        },
      ]);

      // Updating the comment trims whitespace and allows clearing back to quote-only.
      shell.actions.updateResponseAnnotation(id!, "  revised note  ");
      expect(shell.state.getSnapshot().responseAnnotations[0]?.annotation).toBe("revised note");
      shell.actions.updateResponseAnnotation(id!, "   ");
      expect(shell.state.getSnapshot().responseAnnotations[0]?.annotation).toBeUndefined();
    } finally {
      shell.dispose();
    }

    expect(shell.actions.addResponseAnnotation({ text: "after dispose" })).toBeUndefined();
  });

  it("remembers anchors by requestId across submit -> queue edit restore and falls back gracefully without a match", async () => {
    let submittedText = "";
    const shell = createShell({
      onSubmit: ({ text, onRequestId }) => {
        submittedText = text;
        onRequestId?.("req-42");
      },
    });
    try {
      const anchor = {
        answerKey: "answer-9",
        startOffset: 4,
        endOffset: 18,
        quote: "first sentence",
        prefix: "pre ",
        suffix: " post",
      };
      shell.actions.addResponseAnnotation({
        text: "first sentence",
        annotation: "why this?",
        anchor,
      });
      shell.setDraft("Please check this part.");
      shell.submit("queue");
      await Promise.resolve();

      expect(shell.state.getSnapshot().responseAnnotations).toEqual([]);
      expect(shell.draftSnapshot.text).toBe("");
      expect(submittedText).toContain("<response-annotations>");

      // First edit restore with matching rpcId revives both annotation and DOM anchor.
      restoreQueuedTextAndAnnotations(shell, submittedText, "req-42");
      expect(shell.draftSnapshot.text).toBe("Please check this part.");
      expect(shell.state.getSnapshot().responseAnnotations).toHaveLength(1);
      expect(shell.state.getSnapshot().responseAnnotations[0]).toMatchObject({
        text: "first sentence",
        annotation: "why this?",
        anchor,
      });

      // Entry is consumed once; a later restore with the same rpcId (or after reload) restores without anchor.
      shell.clearResponseAnnotations();
      shell.setDraft("");
      restoreQueuedTextAndAnnotations(shell, submittedText, "req-42");
      expect(shell.state.getSnapshot().responseAnnotations).toHaveLength(1);
      expect(shell.state.getSnapshot().responseAnnotations[0]).toMatchObject({
        text: "first sentence",
        annotation: "why this?",
      });
      expect(shell.state.getSnapshot().responseAnnotations[0]?.anchor).toBeUndefined();
    } finally {
      shell.dispose();
    }
  });
});

describe("restoreQueuedTextAndAnnotations", () => {
  it("restores annotation-only messages without adding stray draft text, and merges into non-empty drafts", () => {
    const shell = createShell();
    try {
      const annotationOnly = composeAnnotatedMessage(
        [{ text: "quoted snippet", annotation: "fix typo" }],
        "",
      );
      restoreQueuedTextAndAnnotations(shell, annotationOnly);
      expect(shell.draftSnapshot.text).toBe("");
      expect(shell.state.getSnapshot().responseAnnotations).toHaveLength(1);
      expect(shell.state.getSnapshot().responseAnnotations[0]).toMatchObject({
        text: "quoted snippet",
        annotation: "fix typo",
      });

      // Restoring another annotated message while the user already has draft text + annotation appends both.
      shell.setDraft("typed while waiting");
      const withBody = composeAnnotatedMessage(
        [{ text: "second quote" }],
        "line 1\n## My request:\nline 2",
      );
      restoreQueuedTextAndAnnotations(shell, withBody);
      expect(shell.draftSnapshot.text).toBe("typed while waiting\nline 1\n## My request:\nline 2");
      expect(shell.state.getSnapshot().responseAnnotations.map((entry) => entry.text)).toEqual([
        "quoted snippet",
        "second quote",
      ]);
    } finally {
      shell.dispose();
    }
  });

  it("leaves plain messages containing '## My request:' verbatim without fabricating annotations", () => {
    const shell = createShell();
    try {
      const plain = "Notes before\n\n## My request:\nKeep this intact.";
      restoreQueuedTextAndAnnotations(shell, plain);
      expect(shell.draftSnapshot.text).toBe(plain);
      expect(shell.state.getSnapshot().responseAnnotations).toEqual([]);
    } finally {
      shell.dispose();
    }
  });
});

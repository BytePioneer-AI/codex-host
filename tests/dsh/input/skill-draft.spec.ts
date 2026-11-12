import { expect, it } from "vitest";
import { restoreHarnessCommandMentions } from "@codexhost/shared-contracts";
import { harnessCommandReference } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/harness-command-reference.ts";
import {
  parseStoredDraft,
  snapshotDraft,
} from "../../../apps/web-ui/packages/client/ui-conversation/src/client/draft.ts";

it.each(["/skill:eli5", "/native-skill", "$build"])(
  "persists a Skill icon/name without changing native invocation %s",
  (invocation) => {
    const reference = harnessCommandReference(invocation, "skill", "Readable name");
    const text = `${reference.clipboardText} Body:\n    keep  spaces`;
    const draft = snapshotDraft(text, [
      {
        ...reference,
        occurrenceId: 1,
        offset: 0,
        length: reference.clipboardText.length,
      },
    ]);
    expect(parseStoredDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(draft.references[0]).toMatchObject({ appearance: "skill", label: "Readable name" });
    expect(restoreHarnessCommandMentions(draft.text)).toBe(`${invocation} Body:\n    keep  spaces`);
  },
);

it.each(["/skill:eli5", "/native-skill", "$build"])(
  "restores a legacy command-prefix Skill draft for %s",
  (invocation) => {
    const reference = harnessCommandReference(invocation);
    const draft = snapshotDraft(`${reference.clipboardText} saved body`, [
      {
        ...reference,
        occurrenceId: 1,
        offset: 0,
        length: reference.clipboardText.length,
      },
    ]);
    expect(reference.ref).toContain("subagent://codexhost-command.");
    const restored = parseStoredDraft(JSON.parse(JSON.stringify(draft)));
    expect(restored).toEqual(draft);
    expect(restoreHarnessCommandMentions(restored!.text)).toBe(`${invocation} saved body`);
  },
);

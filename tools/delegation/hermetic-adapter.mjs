import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";

export function createHermeticGrokAdapter() {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("grok"));
  const originalOpen = adapter.open.bind(adapter);
  adapter.open = async (input) => {
    const opened = await originalOpen(input);
    if (!opened.ok) return opened;
    const session = opened.value;
    const originalExecute = session.execute.bind(session);
    session.execute = async (command) => {
      const accepted = await originalExecute(command);
      if (accepted.ok && command.type === "turn.start") {
        queueMicrotask(() => {
          const text = command.input.map((part) => part.text).join("\n");
          session.appendText(`HERMETIC:${text}`);
          session.succeedTurn();
        });
      }
      return accepted;
    };
    return opened;
  };
  return adapter;
}

import { expect, it, vi } from "vitest";
import { MobileTerminalDraft } from "@deepseek-ai/dsh-client-ui-sidebar-terminal/src/client/mobile-terminal-draft.ts";

it("keeps raw composition text local and clears only after a receipt", async () => {
  const draft = new MobileTerminalDraft();
  draft.edit("nihao");
  draft.edit("你好，abcdefghij🙂");
  const receipt = Promise.withResolvers<void>();
  const send = vi.fn(() => receipt.promise);
  const result = draft.submit(send);
  expect(send).toHaveBeenCalledExactlyOnceWith("你好，abcdefghij🙂");
  expect(draft.state.getSnapshot()).toMatchObject({ text: "你好，abcdefghij🙂", sending: true });
  expect(await draft.submit(send)).toBe(false);
  receipt.resolve();
  expect(await result).toBe(true);
  expect(draft.state.getSnapshot()).toEqual({
    text: "",
    enterMode: "send",
    sending: false,
    uncertain: false,
  });
});

it("retains failed input without retrying and preserves newer edits", async () => {
  const draft = new MobileTerminalDraft();
  draft.edit("命令");
  const send = vi.fn(async () => {
    throw new Error("receipt lost");
  });
  expect(await draft.submit(send)).toBe(false);
  expect(send).toHaveBeenCalledOnce();
  expect(draft.state.getSnapshot()).toEqual({
    text: "命令",
    enterMode: "send",
    sending: false,
    uncertain: true,
  });
  const receipt = Promise.withResolvers<void>();
  const retry = draft.submit(() => receipt.promise);
  draft.edit("new local draft");
  receipt.resolve();
  await retry;
  expect(draft.state.getSnapshot()).toEqual({
    text: "new local draft",
    enterMode: "send",
    sending: false,
    uncertain: false,
  });
});

it("retains each terminal's Enter mode without treating a mode change as a text edit", async () => {
  const draft = new MobileTerminalDraft();
  const other = new MobileTerminalDraft();
  expect(draft.state.getSnapshot().enterMode).toBe("send");
  draft.edit("a command");
  const receipt = Promise.withResolvers<void>();
  const result = draft.submit(() => receipt.promise);
  draft.setEnterMode("insert");
  expect(draft.state.getSnapshot().text).toBe("a command");
  expect(other.state.getSnapshot().enterMode).toBe("send");
  receipt.resolve();
  await result;
  expect(draft.state.getSnapshot()).toEqual({
    text: "",
    enterMode: "insert",
    sending: false,
    uncertain: false,
  });
  const unchanged = draft.state.getSnapshot();
  draft.setEnterMode("insert");
  expect(draft.state.getSnapshot()).toBe(unchanged);
  draft.edit("uncertain command");
  await draft.submit(async () => {
    throw new Error("receipt lost");
  });
  draft.setEnterMode("send");
  expect(draft.state.getSnapshot()).toEqual({
    text: "uncertain command",
    enterMode: "send",
    sending: false,
    uncertain: true,
  });
});

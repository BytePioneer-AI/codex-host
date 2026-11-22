import { describe, expect, it } from "vitest";
import { readNativeScheduleSidebarThread } from "../src/renderer-native-schedule-sidebar.js";

const automation = { id: "task", kind: "heartbeat", targetThreadId: "fixed-thread" };
function fixture(props: Record<string, unknown> = { automation }, marked = true) {
  const owner = { memoizedProps: props, return: null as unknown };
  const wrapper = {
    memoizedProps: marked ? { "data-selected-scheduled-task": undefined } : {},
    return: owner,
  };
  const fiber = { memoizedProps: {}, return: wrapper, alternate: null as unknown };
  const element = { matches: () => true, __reactFiber$fixture: fiber } as unknown as HTMLElement;
  return { element, fiber, wrapper, owner };
}

describe("native schedule sidebar identity", () => {
  it("reads a local fixed chat even when its row is not selected", () => {
    expect(readNativeScheduleSidebarThread(fixture().element)).toBe("fixed-thread");
  });
  it.each([
    { automation: { ...automation, kind: "cron" } },
    { automation: { ...automation, targetThreadId: null } },
    { automation: { ...automation, hostId: "remote" } },
    { automation, hostId: "remote" },
    { item: { automation: { ...automation, conversation_id: "cloud-thread" } } },
  ])("does not infer a local thread from unsupported rows %j", (props) => {
    expect(readNativeScheduleSidebarThread(fixture(props).element)).toBeNull();
  });
  it("requires the native scheduled-row owner and rejects ambiguous identities", () => {
    expect(readNativeScheduleSidebarThread(fixture({ automation }, false).element)).toBeNull();
    const f = fixture();
    f.owner.return = { memoizedProps: { automation: { ...automation, targetThreadId: "other" } } };
    expect(readNativeScheduleSidebarThread(f.element)).toBeNull();
  });
  it("uses the committed tree rather than stale alternate props", () => {
    const old = fixture();
    const current = fixture({ automation: { ...automation, targetThreadId: "committed-thread" } });
    old.fiber.alternate = current.fiber;
    const root = { stateNode: { current: {} as unknown }, child: current.owner };
    root.stateNode.current = root;
    old.owner.return = root;
    current.owner.return = root;
    Object.assign(current.owner, { child: current.wrapper });
    Object.assign(current.wrapper, { child: current.fiber });
    expect(readNativeScheduleSidebarThread(old.element)).toBe("committed-thread");
  });
});

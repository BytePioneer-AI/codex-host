// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindPhoneSidebarSwipe } from "../../apps/web-ui/packages/client/ui-layout/src/client/phone-sidebar-swipe.ts";

describe("phone sidebar swipe", () => {
  let frame: HTMLDivElement;
  let body: HTMLElement;
  let dispose: () => void;
  const open = vi.fn();
  const touch = (x: number, y = 100, identifier = 1) => ({ clientX: x, clientY: y, identifier });
  function emit(type: string, points: ReturnType<typeof touch>[], target = body, time = 100) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: type === "touchend" ? [] : points },
      changedTouches: { value: points },
      timeStamp: { value: time },
    });
    target.dispatchEvent(event);
    return event;
  }
  function swipe(target = body, endX = 200, endY = 100, endTime = 300) {
    emit("touchstart", [touch(100)], target);
    emit("touchmove", [touch(endX, endY)], target, 200);
    emit("touchend", [touch(endX, endY)], target, endTime);
  }
  beforeEach(() => {
    document.body.innerHTML =
      '<div data-phone data-sidebar-collapsed><div id="body">Message</div></div>';
    frame = document.body.firstElementChild as HTMLDivElement;
    body = frame.firstElementChild as HTMLElement;
    open.mockClear();
    dispose = bindPhoneSidebarSwipe(frame, "right", open);
  });
  afterEach(() => {
    dispose();
    document.body.innerHTML = "";
    document.getSelection()?.removeAllRanges();
  });
  it("opens on a deliberate right swipe and consumes only horizontal movement", () => {
    emit("touchstart", [touch(100)]);
    expect(emit("touchmove", [touch(105, 102)]).defaultPrevented).toBe(false);
    expect(emit("touchmove", [touch(190, 105)]).defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
    emit("touchend", [touch(190, 105)], body, 300);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("supports left swipes without accepting the opposite direction", () => {
    dispose();
    dispose = bindPhoneSidebarSwipe(frame, "left", open);
    swipe();
    expect(open).not.toHaveBeenCalled();
    swipe(body, 20);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it.each([
    [130, 100, 300],
    [200, 190, 300],
    [200, 100, 900],
  ])("ignores short, diagonal and slow swipes (%i, %i, %i)", (x, y, time) => {
    swipe(body, x, y, time);
    expect(open).not.toHaveBeenCalled();
  });
  it("does not turn an established vertical scroll into navigation", () => {
    emit("touchstart", [touch(100)]);
    expect(emit("touchmove", [touch(102, 125)]).defaultPrevented).toBe(false);
    emit("touchmove", [touch(210, 130)]);
    emit("touchend", [touch(210, 130)]);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["touchcancel", "multitouch", "identifier"])("abandons %s gestures", (kind) => {
    emit("touchstart", [touch(100)]);
    emit("touchmove", [touch(180)]);
    if (kind === "touchcancel") emit("touchcancel", []);
    if (kind === "multitouch") emit("touchstart", [touch(180), touch(190, 100, 2)]);
    if (kind === "identifier") emit("touchmove", [touch(190, 100, 2)]);
    emit("touchend", [touch(220)]);
    expect(open).not.toHaveBeenCalled();
  });
  it.each([
    "<textarea></textarea>",
    "<input>",
    "<button>Send</button>",
    '<a href="#">Link</a>',
    '<div contenteditable="true">Draft</div>',
    '<div role="slider"></div>',
    '<div data-sidebar-right-session="session">Panel</div>',
    "<div data-phone-drawer>Sidebar</div>",
  ])("leaves interactive content alone: %s", (html) => {
    body.innerHTML = html;
    swipe(body.firstElementChild as HTMLElement);
    expect(open).not.toHaveBeenCalled();
  });
  it("leaves horizontally scrolling content alone, including its descendants", () => {
    body.style.overflowX = "auto";
    Object.defineProperties(body, { scrollWidth: { value: 600 }, clientWidth: { value: 300 } });
    body.innerHTML = "<code>Wide code</code>";
    swipe(body.firstElementChild as HTMLElement);
    expect(open).not.toHaveBeenCalled();
  });
  it("leaves selected text and open modals alone", () => {
    const range = document.createRange();
    range.selectNodeContents(body);
    document.getSelection()?.addRange(range);
    swipe();
    expect(open).not.toHaveBeenCalled();
    document.getSelection()?.removeAllRanges();
    document.body.insertAdjacentHTML("beforeend", '<div aria-modal="true"></div>');
    swipe();
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["selection", "modal", "resize", "drawer"])(
    "abandons navigation when %s changes before release",
    (kind) => {
      emit("touchstart", [touch(100)]);
      emit("touchmove", [touch(180)]);
      if (kind === "selection") {
        const range = document.createRange();
        range.selectNodeContents(body);
        document.getSelection()?.addRange(range);
      }
      if (kind === "modal")
        document.body.insertAdjacentHTML("beforeend", '<div aria-modal="true"></div>');
      if (kind === "resize") frame.removeAttribute("data-phone");
      if (kind === "drawer") frame.removeAttribute("data-sidebar-collapsed");
      emit("touchend", [touch(200)]);
      expect(open).not.toHaveBeenCalled();
    },
  );
  describe("right panel return swipe", () => {
    let panel: HTMLElement;
    beforeEach(() => {
      dispose();
      frame.innerHTML =
        '<div data-sidebar-right-session="session"><div data-sidebar-right-panel="fullscreen" data-sidebar-right-open><div id="body">Panel content</div></div></div>';
      panel = frame.querySelector("[data-sidebar-right-panel]")!;
      body = panel.firstElementChild as HTMLElement;
      dispose = bindPhoneSidebarSwipe(frame, "right", open, "rightbar");
    });
    it("accepts a right swipe only inside the open panel", () => {
      swipe(frame);
      expect(open).not.toHaveBeenCalled();
      swipe();
      expect(open).toHaveBeenCalledTimes(1);
    });
    it("accepts swipes across navigation buttons without treating them as input fields", () => {
      body.innerHTML = "<button><span>Workspace files</span></button>";
      swipe(body.querySelector("span")!);
      expect(open).toHaveBeenCalledTimes(1);
    });
    it("ignores left swipes and closed panels", () => {
      swipe(body, 20);
      panel.removeAttribute("data-sidebar-right-open");
      swipe();
      expect(open).not.toHaveBeenCalled();
    });
    it.each(["hidden", "collapsed", "removed"])(
      "does not act on a %s panel after the gesture starts",
      (kind) => {
        emit("touchstart", [touch(100)]);
        emit("touchmove", [touch(180)]);
        if (kind === "hidden") panel.parentElement!.hidden = true;
        if (kind === "collapsed") panel.removeAttribute("data-sidebar-right-open");
        if (kind === "removed") panel.remove();
        emit("touchend", [touch(200)], frame);
        expect(open).not.toHaveBeenCalled();
      },
    );
    it.each([
      "<canvas></canvas>",
      "<iframe></iframe>",
      "<video></video>",
      "<div data-sidebar-terminal>Terminal</div>",
      '<div data-dockkit-host="float">Floating pane</div>',
      "<div data-dockkit-strip-tabs>Tabs</div>",
      "<div data-dockkit-divider>Resize</div>",
      "<textarea>Input</textarea>",
    ])("preserves content-owned input: %s", (html) => {
      body.innerHTML = html;
      swipe(body.firstElementChild as HTMLElement);
      expect(open).not.toHaveBeenCalled();
    });
    it("preserves horizontal scrolling and vertical scrolling", () => {
      swipe(body, 105, 200);
      expect(open).not.toHaveBeenCalled();
      body.style.overflowX = "auto";
      Object.defineProperties(body, { scrollWidth: { value: 600 }, clientWidth: { value: 300 } });
      body.innerHTML = "<code>Wide code</code>";
      swipe(body.firstElementChild as HTMLElement);
      expect(open).not.toHaveBeenCalled();
    });
  });
  it("ignores wide frames, open drawers and disposed listeners", () => {
    frame.removeAttribute("data-phone");
    swipe();
    frame.setAttribute("data-phone", "");
    frame.removeAttribute("data-sidebar-collapsed");
    swipe();
    frame.setAttribute("data-sidebar-collapsed", "");
    dispose();
    swipe();
    expect(open).not.toHaveBeenCalled();
  });
});

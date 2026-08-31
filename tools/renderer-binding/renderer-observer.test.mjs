import { describe, expect, it, vi } from "vitest";

import { installRendererObserver, validateRendererObserverStatus } from "./renderer-observer.mjs";

const validStatus = {
  version: 1,
  switchCounters: { attempts: 1, committed: 1, rejected: 0 },
  observations: [
    {
      submissionId: "tooling-submission-1",
      composerId: "composer-1",
      agent: "pi",
      trigger: "click",
      capturedAt: "2026-07-28T12:00:00.000Z",
    },
  ],
  diagnostics: { editorCandidates: 1, shapes: [] },
};

describe("Renderer tooling observer", () => {
  it("installs syntactically valid Renderer code", async () => {
    const execute = vi.fn(async (source) => {
      expect(() => new Function(source)).not.toThrow();
      return validStatus;
    });

    await expect(installRendererObserver(execute)).resolves.toEqual(validStatus);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("records a switch after the product click handler establishes switching state", async () => {
    const documentListeners = new Map();
    class FakeElement {
      constructor(agent = null) {
        this.dataset = agent === null ? {} : { agent };
        this.disabled = false;
        this.selected = agent === "codex";
      }

      closest(selector) {
        if (selector === "button[data-agent]") return this;
        if (selector === "[data-codexhost-agent-control]") return control;
        return null;
      }

      getAttribute(name) {
        if (name === "aria-pressed") return String(this.selected);
        if (name === "data-codexhost-agent-control") return "composer-1";
        return null;
      }
    }
    const codex = new FakeElement("codex");
    const pi = new FakeElement("pi");
    const control = new FakeElement();
    control.querySelector = (selector) => (selector.includes('"pi"') ? pi : codex);
    control.querySelectorAll = () => [codex, pi];
    const window_ = {
      innerWidth: 1_000,
      innerHeight: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const document_ = {
      body: new FakeElement(),
      addEventListener(type, listener, capture) {
        documentListeners.set(type, { listener, capture });
      },
      removeEventListener: vi.fn(),
      querySelector: () => control,
      querySelectorAll: () => [],
      elementsFromPoint: () => [],
    };
    vi.stubGlobal("window", window_);
    vi.stubGlobal("document", document_);
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("CSS", { escape: (value) => value });
    try {
      await installRendererObserver(async (source) => {
        new Function(source)();
        return window_.__codexhostRendererBindingObserverV1.status();
      });
      const click = documentListeners.get("click");
      expect(click.capture).toBe(true);

      click.listener({ target: pi });
      codex.disabled = true;
      pi.disabled = true;
      setTimeout(() => {
        codex.selected = false;
        pi.selected = true;
        codex.disabled = false;
        pi.disabled = false;
      }, 5);
      await vi.waitFor(
        () => {
          expect(window_.__codexhostRendererBindingObserverV1.status().switchCounters).toEqual({
            attempts: 1,
            committed: 1,
            rejected: 0,
          });
        },
        { timeout: 1_000, interval: 10 },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts the complete production external Agent set", () => {
    for (const agent of ["opencode", "grok", "omp"]) {
      expect(
        validateRendererObserverStatus({
          ...validStatus,
          observations: [{ ...validStatus.observations[0], agent }],
        }),
      ).toBeTruthy();
    }
  });

  it("validates sanitized submission observations", () => {
    expect(validateRendererObserverStatus(validStatus)).toBe(validStatus);
  });

  it("rejects impossible switch counters", () => {
    expect(() =>
      validateRendererObserverStatus({
        ...validStatus,
        switchCounters: { attempts: 1, committed: 1, rejected: 1 },
      }),
    ).toThrow("invalid status");
  });

  it("rejects an observation containing an unsupported field classification", () => {
    expect(() =>
      validateRendererObserverStatus({
        ...validStatus,
        observations: [{ ...validStatus.observations[0], agent: "unknown" }],
      }),
    ).toThrow("invalid observation");
  });
});

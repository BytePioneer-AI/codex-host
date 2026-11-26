// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { PDFPageProxy, PageViewport } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PDF_PAGE_RASTER_PIXELS,
  renderPdfPage,
  type PdfDocument,
  type PdfSession,
  type RenderPdfText,
} from "../src/client/pdf/document.ts";
import type { ZoomViewportProps } from "../src/client/zoom/ZoomViewport.tsx";

const { openPdfMock, pdfTextRendererMock } = vi.hoisted(() => ({
  openPdfMock:
    vi.fn<
      (
        data: Uint8Array<ArrayBuffer>,
        signal: AbortSignal,
        reportFailure: (error: unknown) => void,
      ) => PdfSession
    >(),
  pdfTextRendererMock: vi.fn<(host: HTMLDivElement) => RenderPdfText>(),
}));

vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  Button: ({
    children,
    onClick,
  }: {
    readonly children?: ReactNode;
    readonly onClick?: () => void;
  }) => createElement("button", { type: "button", onClick }, children),
}));

vi.mock("../src/client/pdf/runtime.ts", () => ({
  openPdf: openPdfMock,
}));

vi.mock("../src/client/pdf/text.ts", () => ({
  pdfTextRenderer: pdfTextRendererMock,
}));

import { PdfBody, type PdfBodyProps } from "../src/client/pdf/pdf.tsx";

interface MockObserverRecord {
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly targets: Set<Element>;
  disconnected: boolean;
}

class FakeIntersectionObserver implements IntersectionObserver {
  static records: MockObserverRecord[] = [];

  readonly root = null;
  readonly rootMargin: string;
  readonly thresholds = [0];
  private readonly record: MockObserverRecord;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.rootMargin = options?.rootMargin ?? "0px";
    this.record = {
      callback,
      options,
      targets: new Set(),
      disconnected: false,
    };
    FakeIntersectionObserver.records.push(this.record);
  }

  observe(target: Element): void {
    this.record.targets.add(target);
  }

  unobserve(target: Element): void {
    this.record.targets.delete(target);
  }

  disconnect(): void {
    this.record.disconnected = true;
    this.record.targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  static emit(target: Element, isIntersecting: boolean): void {
    for (const record of FakeIntersectionObserver.records) {
      if (record.disconnected || !record.targets.has(target)) continue;
      record.callback(
        [
          {
            target,
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    }
  }

  static activeObserverFor(pageElement: Element): MockObserverRecord | undefined {
    return FakeIntersectionObserver.records.find(
      (record) =>
        !record.disconnected &&
        Array.from(record.targets).some(
          (target) => target === pageElement || pageElement.contains(target),
        ),
    );
  }
}

function makeFakePage(options: {
  width: number;
  height: number;
  onRender?: (args: {
    canvas: HTMLCanvasElement;
    viewport: PageViewport;
    transform?: number[];
  }) => { promise: Promise<void>; cancel: () => void };
}) {
  const cleanup = vi.fn();
  const render = vi.fn(
    (args: { canvas: HTMLCanvasElement; viewport: PageViewport; transform?: number[] }) => {
      if (options.onRender !== undefined) return options.onRender(args);
      return {
        promise: Promise.resolve(),
        cancel: vi.fn(),
      };
    },
  );
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: options.width,
      height: options.height,
      scale,
      userUnit: 1,
    })),
    render,
    cleanup,
  } as unknown as PDFPageProxy;
  return { page, render, cleanup };
}

function TestZoomViewport({ children }: ZoomViewportProps): ReactNode {
  return createElement("div", { "data-test-zoom-viewport": "" }, children);
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("renderPdfPage raster pixel cap", () => {
  it("caps raster allocation at 8_388_608 pixels while keeping CSS display dimensions unchanged", async () => {
    const { page, render, cleanup } = makeFakePage({ width: 1600, height: 2000 });
    const doc: PdfDocument = {
      numPages: 1,
      getPage: vi.fn(async () => page),
    };
    const canvas = document.createElement("canvas");
    const signal = new AbortController().signal;

    // 1600 * 2000 * 2^2 = 12_800_000 exceeds the 8_388_608 raster pixel cap.
    const size = await renderPdfPage(doc, 1, canvas, signal, 2);

    const expectedRatio = Math.sqrt(MAX_PDF_PAGE_RASTER_PIXELS / (1600 * 2000));
    expect(MAX_PDF_PAGE_RASTER_PIXELS).toBe(8_388_608);
    expect(canvas.width).toBe(Math.floor(1600 * expectedRatio));
    expect(canvas.height).toBe(Math.floor(2000 * expectedRatio));
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(8_388_608);
    expect(size).toEqual({ width: 1600, height: 2000 });
    expect(canvas.style.getPropertyValue("--pdf-page-width")).toBe("1600px");
    expect(canvas.style.getPropertyValue("--pdf-page-height")).toBe("2000px");
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: [expectedRatio, 0, 0, expectedRatio, 0, 0],
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves full pixelRatio when raster size is within the 8_388_608 pixel budget", async () => {
    const { page } = makeFakePage({ width: 816, height: 1056 });
    const doc: PdfDocument = {
      numPages: 1,
      getPage: vi.fn(async () => page),
    };
    const canvas = document.createElement("canvas");

    const size = await renderPdfPage(doc, 1, canvas, new AbortController().signal, 2);

    expect(canvas.width).toBe(1632);
    expect(canvas.height).toBe(2112);
    expect(size).toEqual({ width: 816, height: 1056 });
  });
});

describe("PdfBody offscreen canvas reclaim and redraw", () => {
  let container: HTMLDivElement;
  let originalIntersectionObserver: typeof globalThis.IntersectionObserver;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalDevicePixelRatio: number;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeIntersectionObserver.records = [];
    originalIntersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      drawImage: vi.fn(),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    originalDevicePixelRatio = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });

    openPdfMock.mockReset();
    pdfTextRendererMock.mockReset();

    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    globalThis.IntersectionObserver = originalIntersectionObserver;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    Object.defineProperty(window, "devicePixelRatio", {
      value: originalDevicePixelRatio,
      configurable: true,
    });
  });

  function mountPdf(
    doc: PdfDocument,
    options?: {
      readonly initialPage?: number;
      readonly onIntrinsicWidth?: (width: number | undefined) => void;
    },
  ) {
    const tabController = new AbortController();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const disposeSession = vi.fn(async () => {});
    openPdfMock.mockReturnValue({
      document: Promise.resolve(doc),
      dispose: disposeSession,
    });

    const CapturingZoomViewport = (viewportProps: ZoomViewportProps): ReactNode => {
      options?.onIntrinsicWidth?.(viewportProps.intrinsicWidth);
      return createElement(TestZoomViewport, viewportProps);
    };

    const initialByTab =
      options?.initialPage === undefined ? {} : { "tab-1": { page: options.initialPage } };

    const props: PdfBodyProps & { readonly loading: ReactNode } = {
      content: { kind: "bytes", data: bytes },
      useTabInfo: () => ({
        tab: { id: "tab-1", signal: tabController.signal } as never,
      }),
      useStore: (selector) => selector({ byTab: initialByTab } as never),
      actions: {
        page: vi.fn(),
        zoom: vi.fn(),
        forget: vi.fn(),
      } as never,
      t: ((key: string) => key) as never,
      retainTab: vi.fn(),
      ZoomViewport: options?.onIntrinsicWidth ? CapturingZoomViewport : TestZoomViewport,
      zoomSurfaceClass: "zoom-surface",
      scrollportRef: vi.fn(),
      loading: createElement("div", null, "loading"),
    } as unknown as PdfBodyProps & { readonly loading: ReactNode };

    const root = createRoot(container);
    act(() => {
      root.render(createElement(PdfBody, props));
    });
    return {
      unmount: () => {
        act(() => {
          root.unmount();
        });
      },
      tabController,
    };
  }

  it("reclaims offscreen canvas backing store while keeping placeholder geometry, then redraws on re-entry without duplicating text layers", async () => {
    const page1 = makeFakePage({ width: 600, height: 800 });
    const page2 = makeFakePage({ width: 600, height: 800 });
    const doc: PdfDocument = {
      numPages: 2,
      getPage: vi.fn(async (n: number) => (n === 1 ? page1.page : page2.page)),
    };

    const textCancelSpies: Array<ReturnType<typeof vi.fn>> = [];
    pdfTextRendererMock.mockImplementation((host) => () => {
      const layer = host.ownerDocument.createElement("div");
      layer.className = "textLayer";
      layer.textContent = "selectable text";
      host.append(layer);
      const cancel = vi.fn(() => {
        layer.remove();
      });
      textCancelSpies.push(cancel);
      return {
        promise: Promise.resolve(),
        cancel,
      };
    });

    const { unmount } = mountPdf(doc);
    await flushAsyncWork();

    const page1Host = container.querySelector<HTMLDivElement>('[data-pdf-page="1"]')!;
    const page1Surface = page1Host.querySelector<HTMLDivElement>("[data-document-zoom-surface]")!;
    const page1Canvas = page1Host.querySelector<HTMLCanvasElement>("canvas")!;
    const page1Text = page1Host.querySelector<HTMLDivElement>("[data-pdf-text]")!;

    // 1. Page 1 rendered at 2x DPR with exact placeholder CSS dimensions and one text layer.
    expect(page1.render).toHaveBeenCalledTimes(1);
    expect(page1Canvas.width).toBe(1200);
    expect(page1Canvas.height).toBe(1600);
    expect(page1Host.style.getPropertyValue("--pdf-page-width")).toBe("600px");
    expect(page1Host.style.getPropertyValue("--pdf-page-height")).toBe("800px");
    expect(page1Surface.style.getPropertyValue("--document-zoom-width")).toBe("600px");
    expect(page1Surface.style.aspectRatio).toBe("600 / 800");
    expect(page1Surface.hidden).toBe(false);
    expect(page1Text.querySelectorAll(".textLayer")).toHaveLength(1);

    // Observer watches the sized surface container (not the canvas), using 100% 0px prefetch window.
    const observer = FakeIntersectionObserver.activeObserverFor(page1Host);
    expect(observer).toBeDefined();
    expect(observer?.options?.rootMargin).toBe("100% 0px");
    expect(observer?.targets.has(page1Surface)).toBe(true);
    expect(observer?.targets.has(page1Canvas)).toBe(false);

    // 2. Scroll page 1 out of prefetch window: canvas backing store is reclaimed, placeholder stays intact.
    act(() => {
      FakeIntersectionObserver.emit(page1Surface, false);
    });
    await flushAsyncWork();

    expect(page1Canvas.width).toBe(0);
    expect(page1Canvas.height).toBe(0);
    expect(page1Host.style.getPropertyValue("--pdf-page-width")).toBe("600px");
    expect(page1Host.style.getPropertyValue("--pdf-page-height")).toBe("800px");
    expect(page1Surface.style.getPropertyValue("--document-zoom-width")).toBe("600px");
    expect(page1Surface.style.aspectRatio).toBe("600 / 800");
    expect(page1Surface.hidden).toBe(false);
    expect(FakeIntersectionObserver.activeObserverFor(page1Host)?.targets.has(page1Surface)).toBe(
      true,
    );

    // 3. Scroll page 1 back into prefetch window: re-renders cleanly without duplicating text layers.
    act(() => {
      FakeIntersectionObserver.emit(page1Surface, true);
    });
    await flushAsyncWork();

    expect(page1.render).toHaveBeenCalledTimes(2);
    expect(page1Canvas.width).toBe(1200);
    expect(page1Canvas.height).toBe(1600);
    expect(page1Text.querySelectorAll(".textLayer")).toHaveLength(1);
    expect(pdfTextRendererMock).toHaveBeenCalledTimes(1);

    // 4. Unmounting reclaims main canvas backing store and cleans up text layer.
    unmount();
    expect(page1Canvas.width).toBe(0);
    expect(page1Canvas.height).toBe(0);
    expect(textCancelSpies[0]).toHaveBeenCalledTimes(1);
    expect(page1Text.querySelectorAll(".textLayer")).toHaveLength(0);
  });

  it("cancels an in-flight render when scrolling offscreen and cleanly renders on re-entry", async () => {
    let cancelFirstRender!: () => void;
    let renderAttempt = 0;
    const page2 = makeFakePage({
      width: 500,
      height: 700,
      onRender: () => {
        renderAttempt += 1;
        if (renderAttempt === 1) {
          let rejectRender!: (reason?: unknown) => void;
          const promise = new Promise<void>((_resolve, reject) => {
            rejectRender = reject;
          });
          const cancel = vi.fn(() => {
            rejectRender(new DOMException("cancelled", "AbortError"));
          });
          cancelFirstRender = cancel;
          return { promise, cancel };
        }
        return { promise: Promise.resolve(), cancel: vi.fn() };
      },
    });
    const page1 = makeFakePage({ width: 500, height: 700 });
    const doc: PdfDocument = {
      numPages: 2,
      getPage: vi.fn(async (n: number) => (n === 1 ? page1.page : page2.page)),
    };

    pdfTextRendererMock.mockImplementation((host) => () => {
      const layer = host.ownerDocument.createElement("div");
      layer.className = "textLayer";
      host.append(layer);
      return {
        promise: Promise.resolve(),
        cancel: () => {
          layer.remove();
        },
      };
    });

    const { unmount } = mountPdf(doc);
    await flushAsyncWork();

    const page2Host = container.querySelector<HTMLDivElement>('[data-pdf-page="2"]')!;
    const page2Canvas = page2Host.querySelector<HTMLCanvasElement>("canvas")!;
    const page2Text = page2Host.querySelector<HTMLDivElement>("[data-pdf-text]")!;

    // Enter prefetch window -> starts in-flight render.
    act(() => {
      FakeIntersectionObserver.emit(page2Host, true);
    });
    await flushAsyncWork();
    expect(page2.render).toHaveBeenCalledTimes(1);

    // Leave before completion -> aborts in-flight render, cleans partial text layer, canvas stays 0x0.
    act(() => {
      FakeIntersectionObserver.emit(page2Host, false);
    });
    await flushAsyncWork();
    expect(cancelFirstRender).toHaveBeenCalledTimes(1);
    expect(page2Canvas.width).toBe(0);
    expect(page2Canvas.height).toBe(0);
    expect(page2Text.querySelectorAll(".textLayer")).toHaveLength(0);

    // Re-enter -> renders to completion with exactly one text layer.
    act(() => {
      FakeIntersectionObserver.emit(page2Host, true);
    });
    await flushAsyncWork();
    expect(page2.render).toHaveBeenCalledTimes(2);
    expect(page2Canvas.width).toBe(1000);
    expect(page2Canvas.height).toBe(1400);
    expect(page2Text.querySelectorAll(".textLayer")).toHaveLength(1);

    unmount();
  });

  it("populates ZoomViewport intrinsicWidth from page 1 viewport metadata even when restored to a later page with page 1 offscreen", async () => {
    let cancelPage1Render!: () => void;
    const page1 = makeFakePage({
      width: 612,
      height: 792,
      onRender: () => {
        let rejectRender!: (reason?: unknown) => void;
        const promise = new Promise<void>((_resolve, reject) => {
          rejectRender = reject;
        });
        const cancel = vi.fn(() => {
          rejectRender(new DOMException("cancelled", "AbortError"));
        });
        cancelPage1Render = cancel;
        return { promise, cancel };
      },
    });
    const page5 = makeFakePage({ width: 612, height: 792 });
    const doc: PdfDocument = {
      numPages: 5,
      getPage: vi.fn(async (n: number) => (n === 1 ? page1.page : page5.page)),
    };

    const observedWidths: Array<number | undefined> = [];
    const { unmount } = mountPdf(doc, {
      initialPage: 5,
      onIntrinsicWidth: (width) => {
        observedWidths.push(width);
      },
    });
    await flushAsyncWork();

    // Immediately mark page 1 offscreen so page 1 never completes canvas rendering.
    const page1Host = container.querySelector<HTMLDivElement>('[data-pdf-page="1"]')!;
    act(() => {
      FakeIntersectionObserver.emit(page1Host, false);
    });
    await flushAsyncWork();

    expect(cancelPage1Render).toHaveBeenCalledTimes(1);
    expect(page1.page.getViewport).toHaveBeenCalledWith({ scale: 96 / 72 });
    expect(page1.cleanup).toHaveBeenCalled();
    expect(observedWidths.at(-1)).toBe(612);

    unmount();
  });
});

/** Fixed-pitch virtual turn rail with independent activation and scroll controls. */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
  type PointerEvent,
} from "react";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual";
import type { ChatViewSlotProps } from "../contract/slots.ts";
import type { TurnRailItem } from "./turn-rail-items.ts";
import css from "./TurnNavigator.module.css";

interface TurnNavigatorProps {
  readonly items: readonly TurnRailItem[];
  readonly activeTurn: number | null;
  /** Turn whose jump is still paging history in; its mark pulses. */
  readonly busyTurn: number | null;
  readonly onNavigate: (item: TurnRailItem) => void;
  readonly t: ChatViewSlotProps["t"];
}

/** Imperative controls for known turns; unknown turn numbers are ignored. */
export interface TurnNavigatorHandle {
  /** @param turn - turn to activate through the navigation callback. */
  activateTurn(turn: number): void;
  /** @param turn - turn to center in the rail without navigating the transcript. */
  scrollToTurn(turn: number): void;
}

/** Fixed pitch between neighbouring marks; overflow scrolls inside the frame. */
const TURN_SPACING_PX = 10;
/** Rail padding above the first mark and below the last one, per end. */
const RAIL_INSET_PX = 6;
/** Fade band the mask reserves at a scrollable end. */
const FADE_PX = 40;

function preferredScrollBehavior(): "auto" | "smooth" {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

interface TurnMarkProps extends Pick<TurnNavigatorProps, "onNavigate" | "t"> {
  readonly item: TurnRailItem;
  readonly index: number;
  readonly active: boolean;
  readonly busy: boolean;
  readonly previewId: string | undefined;
  readonly neighborDistance: number | undefined;
  readonly registerElement: (element: HTMLButtonElement | null) => void;
  readonly onPreview: (turn: number | null) => void;
  readonly onFocusChange: (turn: number | null) => void;
}

const TurnMark = memo(function TurnMark({
  item,
  index,
  active,
  busy,
  previewId,
  neighborDistance,
  registerElement,
  onNavigate,
  onPreview,
  onFocusChange,
  t,
}: TurnMarkProps) {
  const classes = [css.mark];
  if (item.anchor.kind === "unloaded") classes.push(css.markUnloaded);
  if (active) classes.push(css.markActive);
  if (neighborDistance === 0) classes.push(css.markPreview);
  if (busy) classes.push(css.markBusy);
  return (
    <button
      ref={registerElement}
      data-index={index}
      data-neighbor-distance={neighborDistance}
      type="button"
      className={classes.join(" ")}
      aria-label={t(
        item.anchor.kind === "loaded" ? "chat.turnNavigation.jump" : "chat.turnNavigation.jumpLoad",
        { turn: index + 1 },
      )}
      aria-current={active ? "true" : undefined}
      aria-busy={busy ? "true" : undefined}
      aria-describedby={previewId}
      onPointerMove={(event) => {
        if (event.buttons === 0) onPreview(item.turn);
      }}
      onClick={() => {
        onNavigate(item);
      }}
      onFocus={() => {
        onFocusChange(item.turn);
      }}
      onBlur={() => {
        onFocusChange(null);
      }}
    />
  );
});

function TurnNavigatorRail(
  { items, activeTurn, busyTurn, onNavigate, t }: TurnNavigatorProps,
  ref: ForwardedRef<TurnNavigatorHandle>,
) {
  const [previewTurn, setPreviewTurn] = useState<number | null>(null);
  const [focusedTurn, setFocusedTurn] = useState<number | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [hasGutter, setHasGutter] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    button: HTMLButtonElement;
    turn: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const clickResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const initialization = useRef({
    placed: false,
    index: 0,
    follow: null as { index: number; count: number; height: number } | null,
    publishOffset: null as ((offset: number, scrolling: boolean) => void) | null,
  });
  /** While the pointer works the rail, follow must not move it under the hand. */
  const pointerInsideRef = useRef(false);
  const previewId = useId();
  const enabled = items.length >= 2;
  // Match the native rail's spatial rule rather than a viewport breakpoint: a
  // collapsed sidebar can leave enough room even in a relatively narrow window.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const column = slot?.parentElement?.querySelector<HTMLElement>("[data-chat-flow]");
    const scroller =
      slot?.closest<HTMLElement>("[data-conversation-scroll]") ?? slot?.parentElement;
    if (!column || !scroller) return;
    const measure = () => {
      const bounds = scroller.getBoundingClientRect();
      const scale = scroller.offsetWidth > 0 ? bounds.width / scroller.offsetWidth : 1;
      setHasGutter((column.getBoundingClientRect().left - bounds.left) / (scale || 1) >= 48);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(scroller);
    measure();
    return () => observer.disconnect();
  }, [enabled]);
  useEffect(() => {
    if (previewTurn === null) {
      setPreviewReady(false);
      return;
    }
    if (previewReady) return;
    const timer = setTimeout(() => setPreviewReady(true), 150);
    return () => clearTimeout(timer);
  }, [previewTurn, previewReady]);
  useEffect(
    () => () => {
      clearTimeout(clickResetTimer.current);
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.button.hasPointerCapture(drag.pointerId))
        drag.button.releasePointerCapture(drag.pointerId);
    },
    [],
  );
  const turnIndexes = useMemo(() => {
    const indexes = new Map<number, number>();
    items.forEach((item, index) => {
      indexes.set(item.turn, index);
    });
    return indexes;
  }, [items]);
  const activeIndex = activeTurn === null ? undefined : turnIndexes.get(activeTurn);
  useLayoutEffect(() => {
    initialization.current.index = activeIndex ?? 0;
  }, [activeIndex]);
  const focusedIndex = focusedTurn === null ? undefined : turnIndexes.get(focusedTurn);
  const previewIndex = previewTurn === null ? undefined : turnIndexes.get(previewTurn);
  const onFocusChange = useCallback((turn: number | null) => {
    setFocusedTurn(turn);
    setPreviewTurn(turn);
    setPreviewReady(turn !== null);
  }, []);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLButtonElement>({
    count: items.length,
    enabled,
    directDomUpdates: true,
    directDomUpdatesMode: "transform",
    useScrollendEvent: true,
    getScrollElement: useCallback(() => scrollerRef.current, []),
    getItemKey: useCallback((index: number) => items[index]?.turn ?? index, [items]),
    estimateSize: () => TURN_SPACING_PX,
    measureElement: () => TURN_SPACING_PX,
    initialRect: { width: 0, height: 0 },
    initialOffset: 0,
    scrollToFn: (offset, options, instance) => {
      if (initialization.current.placed) elementScroll(offset, options, instance);
    },
    observeElementOffset: (instance, notify) => {
      initialization.current.publishOffset = notify;
      const dispose = observeElementOffset(instance, notify);
      return () => {
        dispose?.();
        initialization.current.placed = false;
        initialization.current.follow = null;
        initialization.current.publishOffset = null;
      };
    },
    observeElementRect: (instance, notify) => {
      const element = instance.scrollElement;
      const Observer = instance.targetWindow?.ResizeObserver;
      if (element === null || Observer === undefined) return;
      const observer = new Observer(([entry]) => {
        if (entry === undefined) return;
        const box = entry.borderBoxSize[0];
        const rect = {
          width: Math.round(box?.inlineSize ?? entry.contentRect.width),
          height: Math.round(box?.blockSize ?? entry.contentRect.height),
        };
        const initial = initialization.current;
        if (!initial.placed && rect.height > 0) {
          const max = Math.max(0, instance.getTotalSize() - rect.height);
          const center = initial.index * TURN_SPACING_PX + RAIL_INSET_PX;
          const target = Math.max(0, Math.min(max, center - rect.height / 2));
          initial.placed = true;
          initial.follow = {
            index: initial.index,
            count: instance.options.count,
            height: rect.height,
          };
          element.scrollTop = target;
          initial.publishOffset?.(target, false);
        }
        notify(rect);
      });
      observer.observe(element, { box: "border-box" });
      return () => {
        observer.disconnect();
      };
    },
    paddingStart: RAIL_INSET_PX - TURN_SPACING_PX / 2,
    paddingEnd: RAIL_INSET_PX - TURN_SPACING_PX / 2,
    scrollPaddingStart: FADE_PX,
    scrollPaddingEnd: FADE_PX,
    overscan: 3,
    rangeExtractor: useCallback(
      (range: Range) => {
        const indexes = defaultRangeExtractor(range);
        if (focusedIndex !== undefined) {
          const last = Math.min(range.count - 1, focusedIndex + 1);
          for (let index = Math.max(0, focusedIndex - 1); index <= last; index++) {
            if (!indexes.includes(index)) indexes.push(index);
          }
          indexes.sort((left, right) => left - right);
        }
        return indexes;
      },
      [focusedIndex],
    ),
  });
  const scrollTop = virtualizer.scrollOffset ?? 0;
  const viewHeight = virtualizer.scrollRect?.height ?? 0;
  const virtualItems = virtualizer.getVirtualItems();

  const scrollToIndex = useCallback(
    (
      index: number,
      reveal: "if-needed" | "always",
      behavior: "auto" | "smooth" | "instant" = preferredScrollBehavior(),
    ): void => {
      const item = virtualizer.measurementsCache[index];
      const height = virtualizer.scrollRect?.height ?? 0;
      if (item === undefined || height <= 0) return;
      const current = virtualizer.scrollOffset ?? 0;
      const center = item.start + item.size / 2;
      if (reveal === "if-needed") {
        const { scrollPaddingStart, scrollPaddingEnd } = virtualizer.options;
        if (center >= current + scrollPaddingStart && center <= current + height - scrollPaddingEnd)
          return;
      }
      const target = center - height / 2;
      const max = Math.max(0, virtualizer.getTotalSize() - height);
      const delta = Math.max(0, Math.min(max, target)) - current;
      if (delta !== 0) virtualizer.scrollBy(delta, { behavior });
    },
    [virtualizer],
  );

  useImperativeHandle(
    ref,
    (): TurnNavigatorHandle => ({
      activateTurn(turn) {
        const index = turnIndexes.get(turn);
        const item = index === undefined ? undefined : items[index];
        if (item !== undefined) onNavigate(item);
      },
      scrollToTurn(turn) {
        const index = turnIndexes.get(turn);
        if (index !== undefined) scrollToIndex(index, "always");
      },
    }),
    [items, turnIndexes, onNavigate, scrollToIndex],
  );

  useEffect(() => {
    if (viewHeight <= 0) {
      initialization.current.follow = null;
      return;
    }
    if (activeIndex === undefined || pointerInsideRef.current) return;
    const previous = initialization.current.follow;
    if (
      previous?.index === activeIndex &&
      previous.count === items.length &&
      previous.height === viewHeight
    )
      return;
    initialization.current.follow = { index: activeIndex, count: items.length, height: viewHeight };
    const behavior =
      previous?.count === items.length && previous.height === viewHeight
        ? preferredScrollBehavior()
        : "instant";
    scrollToIndex(activeIndex, "if-needed", behavior);
  }, [activeIndex, items.length, viewHeight, scrollToIndex]);

  const activate = useCallback(
    (item: TurnRailItem) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      onNavigate(item);
    },
    [onNavigate],
  );
  const startDrag = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-index]");
    if (!button || !scrollerRef.current?.contains(button)) return;
    const item = items[Number(button.dataset.index)];
    if (!item) return;
    clearTimeout(clickResetTimer.current);
    suppressClick.current = false;
    dragRef.current = { pointerId: event.pointerId, button, turn: item.turn, moved: false };
    button.setPointerCapture(event.pointerId);
    setScrubbing(true);
    setPreviewTurn(item.turn);
    setPreviewReady(true);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    if (!drag || !scroller || event.pointerId !== drag.pointerId || !(event.buttons & 1)) return;
    const bounds = scroller.getBoundingClientRect();
    const y = Math.max(bounds.top, Math.min(event.clientY, bounds.bottom - 1));
    const index = Math.max(
      0,
      Math.min(
        items.length - 1,
        Math.round((y - bounds.top + scroller.scrollTop - RAIL_INSET_PX) / TURN_SPACING_PX),
      ),
    );
    const item = items[index];
    if (!item || item.turn === drag.turn) return;
    drag.turn = item.turn;
    drag.moved = true;
    setPreviewTurn(item.turn);
    // Like native scrubbing, do not launch history reads for every crossed
    // unloaded mark. A normal click can still load and navigate to that Turn.
    if (item.anchor.kind === "loaded") onNavigate(item);
  };
  const finishDrag = (event: PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setScrubbing(false);
    suppressClick.current = drag.moved;
    if (drag.button.hasPointerCapture(event.pointerId))
      drag.button.releasePointerCapture(event.pointerId);
    clickResetTimer.current = setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (!pointerInsideRef.current) setPreviewTurn(null);
  };

  if (!enabled) return null;
  const preview = !previewReady || previewIndex === undefined ? undefined : items[previewIndex];
  const previewPosition = virtualItems.find((item) => item.index === previewIndex);
  const fadeClasses = [css.scroller];
  if (scrollTop > 1) fadeClasses.push(css.fadeTop);
  if (scrollTop < virtualizer.getTotalSize() - viewHeight - 1) fadeClasses.push(css.fadeBottom);
  return (
    <div ref={slotRef} className={css.slot}>
      <nav
        className={css.frame}
        hidden={!hasGutter}
        data-turn-navigation=""
        data-previewing={previewIndex !== undefined || undefined}
        data-scrubbing={scrubbing || undefined}
        onPointerDownCapture={startDrag}
        onPointerMove={moveDrag}
        onPointerUpCapture={finishDrag}
        onPointerCancelCapture={finishDrag}
        onLostPointerCapture={finishDrag}
        aria-label={t("chat.turnNavigation.label")}
        onPointerEnter={() => {
          pointerInsideRef.current = true;
        }}
        onPointerLeave={() => {
          pointerInsideRef.current = false;
          if (!dragRef.current) setPreviewTurn(null);
        }}
      >
        <div ref={scrollerRef} className={fadeClasses.join(" ")}>
          <div ref={virtualizer.containerRef} className={css.marks}>
            {virtualItems.map(({ index, key }) => {
              const item = items[index];
              if (item === undefined) return null;
              return (
                <TurnMark
                  key={key}
                  item={item}
                  index={index}
                  active={item.turn === activeTurn}
                  busy={item.turn === busyTurn}
                  previewId={previewReady && item.turn === previewTurn ? previewId : undefined}
                  neighborDistance={
                    previewIndex !== undefined && Math.abs(index - previewIndex) <= 3
                      ? Math.abs(index - previewIndex)
                      : undefined
                  }
                  registerElement={virtualizer.measureElement}
                  onNavigate={activate}
                  onPreview={setPreviewTurn}
                  onFocusChange={onFocusChange}
                  t={t}
                />
              );
            })}
          </div>
        </div>
        {preview !== undefined && previewPosition !== undefined && (
          <div
            id={previewId}
            role="tooltip"
            className={css.preview}
            style={
              {
                "--turn-preview-center": `${String(previewPosition.start + previewPosition.size / 2 - scrollTop)}px`,
              } as CSSProperties
            }
          >
            <div className={css.previewPrompt}>
              {preview.prompt || t("chat.turnNavigation.turn", { turn: (previewIndex ?? 0) + 1 })}
            </div>
            {preview.response !== "" && (
              <div className={css.previewResponse}>{preview.response}</div>
            )}
          </div>
        )}
      </nav>
    </div>
  );
}

/**
 * Fixed-pitch rail of every known Turn — loaded marks scroll, unloaded marks
 * page history in first — with hover and focus previews. Overflow scrolls
 * inside the frame, gradient fades marking each scrollable end, and the
 * active mark centers only outside the fade-free band while the pointer is
 * elsewhere. Previews follow pointer movement or focus, not scrolling under
 * a stationary pointer.
 */
export const TurnNavigator = memo(forwardRef(TurnNavigatorRail));

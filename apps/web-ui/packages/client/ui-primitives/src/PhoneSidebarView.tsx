/** Presentation outlet for sidebar-owned menus and dialogs in a phone drawer. */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type MutableRefObject,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { IconChevronLeftOutlineRegular } from "./icons/index.tsx";
import { useModalLayer } from "./useModalLayer.ts";
import css from "./PhoneSidebarView.module.css";

const PhoneSidebarContext = createContext<{
  target: HTMLElement | null;
  backLabel: string;
  open: boolean;
  close: () => void;
  enterView: () => () => void;
  returnFocus: MutableRefObject<HTMLElement | null>;
} | null>(null);

export function PhoneSidebarProvider({
  target,
  backLabel,
  open,
  close,
  enterView,
  children,
}: {
  target: HTMLElement | null;
  backLabel: string;
  open: boolean;
  close: () => void;
  enterView: () => () => void;
  children: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const value = useMemo(
    () => (target === null ? null : { target, backLabel, open, close, enterView, returnFocus }),
    [target, backLabel, open, close, enterView],
  );
  return <PhoneSidebarContext.Provider value={value}>{children}</PhoneSidebarContext.Provider>;
}

export function usePhoneSidebar() {
  return useContext(PhoneSidebarContext);
}

/** Reuses the owner's close/pending contract and the standard focus lifetime. */
export function PhoneSidebarView({
  title,
  onBack,
  footerBackLabel,
  children,
  className,
  onKeyDownCapture,
}: {
  title: string;
  onBack: () => void;
  /** Optional thumb-reachable return for the session details view only. */
  footerBackLabel?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
  onKeyDownCapture?: React.KeyboardEventHandler<HTMLDivElement> | undefined;
}) {
  const sidebar = usePhoneSidebar();
  const view = useRef<HTMLDivElement>(null);
  const target = sidebar?.target;
  const enterView = sidebar?.enterView;
  const returnFocus = sidebar?.returnFocus;
  useLayoutEffect(() => enterView?.(), [enterView]);
  useLayoutEffect(() => {
    const active = document.activeElement;
    const previous = active instanceof HTMLElement && active !== document.body ? active : null;
    const content = target?.parentElement?.querySelector<HTMLElement>(
      "[data-phone-sidebar-content]",
    );
    if (previous && content?.contains(previous) && returnFocus) returnFocus.current = previous;
    if (content) content.inert = true;
    return () => {
      queueMicrotask(() => {
        if (content) content.inert = target?.querySelector("[data-phone-sidebar-view]") !== null;
        const focused = document.activeElement;
        if (!target?.closest("[data-phone-drawer][data-open]")) return;
        if (
          focused !== document.body &&
          focused?.isConnected &&
          !focused.matches("[data-phone-drawer]") &&
          content?.contains(focused) !== true
        )
          return;
        const fallback = target
          ?.closest("[data-phone-drawer]")
          ?.querySelector<HTMLElement>("[data-phone-sidebar-return]");
        const control =
          previous?.isConnected && previous.getClientRects().length > 0
            ? previous
            : returnFocus?.current?.isConnected && returnFocus.current.getClientRects().length > 0
              ? returnFocus.current
              : fallback;
        control?.focus({ preventScroll: true });
      });
    };
  }, [target, returnFocus]);
  useModalLayer(view, sidebar?.open === true, onBack);
  const back = useRef(onBack);
  back.current = onBack;
  const wasDrawerOpen = useRef(sidebar?.open === true);
  useEffect(() => {
    const closed = wasDrawerOpen.current && sidebar?.open === false;
    wasDrawerOpen.current = sidebar?.open === true;
    if (closed) back.current();
  }, [sidebar?.open]);
  if (sidebar?.target == null) return null;
  const content = (
    <>
      <div className={css.header}>
        <button type="button" className={css.back} aria-label={sidebar.backLabel} onClick={onBack}>
          <IconChevronLeftOutlineRegular />
        </button>
        <h2>{title}</h2>
      </div>
      {children}
    </>
  );
  return createPortal(
    <div
      ref={view}
      className={clsx(className, css.view, footerBackLabel !== undefined && css.withFooter)}
      data-phone-sidebar-view
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onKeyDownCapture={onKeyDownCapture}
      onClick={(event) => event.stopPropagation()}
    >
      {footerBackLabel === undefined ? (
        content
      ) : (
        <>
          <div className={css.content}>{content}</div>
          <div className={css.footer}>
            <button type="button" className={css.footerBack} onClick={onBack}>
              {footerBackLabel}
            </button>
          </div>
        </>
      )}
    </div>,
    sidebar.target,
  );
}

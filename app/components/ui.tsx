import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { motion, usePresence } from "motion/react";
import { useReducedMotionPreference } from "./use-reduced-motion";
import "../popover.css";

export type IconName = "home" | "video" | "team" | "folder" | "search" | "plus" | "chevron" | "upload" | "close" | "comment" | "share" | "slack" | "arrow" | "check" | "menu" | "sidebar" | "play" | "pause" | "volume" | "volume-off" | "fullscreen" | "exit-fullscreen" | "sparkle" | "more" | "edit" | "trash" | "send";

export function Icon({ name, size = 20, ...props }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /><path d="M9 21v-7h6" /></>,
    video: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m10 8 5 4-5 4Z" /></>,
    team: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M17 15a5 5 0 0 1 4 5v1" /></>,
    folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    chevron: <path d="m8 10 4 4 4-4" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    comment: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />,
    share: <><circle cx="18" cy="5" r="3" /><circle cx="5" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8 10 7-4M8 14l7 4" /></>,
    slack: <><path d="M8 2v13M2 8h13M16 9v13M9 16h13M4 3v1M20 20v1M20 3h1M3 20h1" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="m22 2-11 11" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    play: <path d="m9 5 11 7-11 7Z" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    volume: <><path d="m11 4-5 4H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>,
    "volume-off": <><path d="m11 4-5 4H3v8h3l5 4ZM16 9l6 6M16 15l6-6" /></>,
    fullscreen: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    "exit-fullscreen": <path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5" />,
    sparkle: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" /><path d="M13 20h8" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

export function Avatar({ name, image, small = false }: { name: string; image?: string | null; small?: boolean }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "?";
  return <span className={`avatar${small ? " small" : ""}`} aria-hidden="true">{initials}{image && <img key={image} src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />}</span>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice${error ? " error" : ""}`} role={error ? "alert" : "status"}>{children}</div>;
}

export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name="video" size={27} /></span><h2>{title}</h2><p>{children}</p>{action}</div>;
}

export function Modal({ title, children, onClose, busy = false, className = "", initialFocus }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string; initialFocus?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [present, safeToRemove] = usePresence();
  const [requested, setRequested] = useState(false);
  const closing = requested || !present;
  const closingRef = useRef(closing); closingRef.current = closing;
  const requestedRef = useRef(requested); requestedRef.current = requested;
  const remove = useRef(safeToRemove); remove.current = safeToRemove;
  const finished = useRef(false);
  const restore = useRef<() => void>(() => {});
  const reduced = useReducedMotionPreference();
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restore.current = () => {
      const others = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(item => item !== dialog);
      if (others.some(item => item.contains(document.activeElement))) return;
      const another = others[0];
      if (previous?.isConnected && !previous.closest('[inert]') && (!another || another.contains(previous))) previous.focus({ preventScroll: true });
    };
    dialog?.showModal();
    initialFocus?.current?.focus();
    return () => { dialog?.close(); if (!finished.current) restore.current(); };
  }, []);
  function finish() {
    if (!closingRef.current) return;
    if (!finished.current) {
      finished.current = true; ref.current?.close(); restore.current();
      if (requestedRef.current) closeRef.current();
    }
    remove.current?.();
  }
  useEffect(() => {
    if (!closing) return;
    if (finished.current) { remove.current?.(); return; }
    const timer = window.setTimeout(finish, 320);
    return () => window.clearTimeout(timer);
  }, [closing, present]);
  function requestClose() { if (!busy && !closingRef.current) { closingRef.current = true; setRequested(true); } }
  const hidden = { opacity: 0, transform: reduced ? "translateY(0px) scale(1)" : "translateY(8px) scale(.985)" };
  return (
    <motion.dialog ref={ref} className={`modal ${className}`} aria-labelledby={titleId} aria-hidden={closing || undefined} inert={closing} data-state={closing ? "closing" : "open"} initial={hidden} animate={closing ? hidden : { opacity: 1, transform: "translateY(0px) scale(1)" }} transition={{ duration: reduced ? .12 : .16, ease: [.16, 1, .3, 1] }} style={{ pointerEvents: closing ? "none" : undefined }} onAnimationComplete={finish} onCancel={event => { event.preventDefault(); requestClose(); }} onClick={event => { if (event.target === event.currentTarget) requestClose(); }}>
      <div className="modal-inner"><header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={requestClose} disabled={busy || closing}><Icon name="close" /></button></header>{children}</div>
    </motion.dialog>
  );
}

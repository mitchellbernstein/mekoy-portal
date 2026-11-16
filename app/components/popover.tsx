import { useEffect, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type Ref, type RefObject } from "react";
import { AnimatePresence, motion, usePresence } from "motion/react";
import { useLocation } from "react-router";
import { useReducedMotionPreference } from "./use-reduced-motion";
import "../popover.css";

export type PopoverProps = {
  open: boolean; anchor: RefObject<HTMLElement | null>; label: string; onClose(): void; children: ReactNode; ref?: Ref<HTMLDivElement>;
} & Pick<HTMLAttributes<HTMLDivElement>, "className" | "id" | "role" | "onKeyDown">;

export function Popover({ open, ...props }: PopoverProps) {
  const location = useLocation();
  const previous = useRef(location.key);
  const close = useRef(props.onClose); close.current = props.onClose;
  useEffect(() => {
    if (previous.current !== location.key) close.current();
    previous.current = location.key;
  }, [location.key]);
  return <AnimatePresence>{open && <PopoverPanel key="popover" {...props}/>}</AnimatePresence>;
}

function PopoverPanel({ anchor, label, onClose, children, ref: forwarded, className = "", role = "dialog", ...props }: Omit<PopoverProps, "open">) {
  const panel = useRef<HTMLDivElement>(null);
  const [present, safeToRemove] = usePresence();
  const presence = useRef(present); presence.current = present;
  const remove = useRef(safeToRemove); remove.current = safeToRemove;
  const close = useRef(onClose); close.current = onClose;
  const reduced = useReducedMotionPreference();
  function finish() {
    if (presence.current) return;
    panel.current?.hidePopover();
    remove.current?.();
  }
  useEffect(() => {
    if (present) return;
    const timer = window.setTimeout(finish, 320);
    return () => window.clearTimeout(timer);
  }, [present]);
  useLayoutEffect(() => {
    const popup = panel.current;
    if (!popup) return;
    function position() {
      const trigger = anchor.current;
      if (!trigger?.isConnected || trigger.closest('[inert], [hidden]') || !trigger.getClientRects().length) { close.current(); return; }
      const bounds = trigger.getBoundingClientRect(), width = popup!.offsetWidth, height = popup!.offsetHeight;
      const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8));
      const above = bounds.bottom + height + 8 > window.innerHeight && bounds.top > window.innerHeight - bounds.bottom;
      const top = Math.max(8, Math.min(above ? bounds.top - height - 6 : bounds.bottom + 6, window.innerHeight - height - 8));
      popup!.style.left = `${left}px`; popup!.style.top = `${top}px`;
      popup!.style.transformOrigin = `${Math.max(0, Math.min(width, bounds.left + bounds.width / 2 - left))}px ${above ? height : 0}px`;
    }
    popup.showPopover(); position();
    popup.querySelector<HTMLElement>('button:not(:disabled), a[href], input, [tabindex="0"]')?.focus();
    function outside(event: PointerEvent) { if (!document.querySelector('dialog[open]') && event.target instanceof Node && !popup!.contains(event.target) && !anchor.current?.contains(event.target)) close.current(); }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      event.preventDefault(); event.stopPropagation(); close.current(); anchor.current?.focus();
    }
    function scroll(event: Event) { if (event.target === document || event.target instanceof Element && anchor.current && event.target.contains(anchor.current)) close.current(); }
    const resized = new ResizeObserver(position); resized.observe(popup); if (anchor.current) resized.observe(anchor.current);
    const changed = new MutationObserver(() => { if (!anchor.current?.isConnected || anchor.current.closest('[inert], [hidden]')) close.current(); });
    changed.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "hidden"] });
    document.addEventListener("pointerdown", outside); window.addEventListener("keydown", escape); window.addEventListener("resize", position); document.addEventListener("scroll", scroll, true);
    return () => {
      resized.disconnect(); changed.disconnect(); document.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); window.removeEventListener("resize", position); document.removeEventListener("scroll", scroll, true);
      if (anchor.current?.isConnected && !anchor.current.closest('[inert]') && (document.activeElement === document.body || popup.contains(document.activeElement))) anchor.current.focus();
    };
  }, [anchor]);
  const hidden = { opacity: 0, transform: reduced ? "translateY(0px) scale(1)" : "translateY(-4px) scale(.98)" };
  return <motion.div {...props} ref={element => { panel.current = element; if (typeof forwarded === "function") forwarded(element); else if (forwarded) forwarded.current = element; }} popover="manual" role={role} aria-label={label} aria-hidden={!present || undefined} inert={!present} data-state={present ? "open" : "closing"} className={`popover ${className}`} initial={hidden} animate={present ? { opacity: 1, transform: "translateY(0px) scale(1)" } : hidden} transition={{ duration: reduced ? .12 : .16, ease: [.16, 1, .3, 1] }} style={{ pointerEvents: present ? undefined : "none" }} onAnimationComplete={finish} onBlur={event => { if (presence.current && !(event.relatedTarget instanceof Element && event.relatedTarget.closest('dialog[open]')) && !event.currentTarget.contains(event.relatedTarget) && !anchor.current?.contains(event.relatedTarget)) close.current(); }}>{children}</motion.div>;
}

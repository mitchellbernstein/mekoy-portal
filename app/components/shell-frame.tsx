import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { motion } from "motion/react";
import { useLocation } from "react-router";
import { Icon } from "./ui";
import { WindowChrome, type ShellHistory, type WorkspaceSidebarOverride } from "./window-chrome";
import { useReducedMotionPreference } from "./use-reduced-motion";
import "../sidebar-motion.css";

export function ShellFrame({ sidebar, history, desktop = false, className = "", scrollRef, children }: { sidebar: WorkspaceSidebarOverride; history?: ShellHistory; desktop?: boolean; className?: string; scrollRef?: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  const location = useLocation();
  const reduced = useReducedMotionPreference();
  const drawer = narrow && !desktop;
  const hidden = drawer ? !drawerOpen : collapsed;
  const closeDrawer = useCallback(() => {
    if (aside.current?.contains(document.activeElement)) root.current?.querySelector<HTMLButtonElement>('.mobile-menu')?.focus();
    setDrawerOpen(false);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => { setNarrow(media.matches); if (!media.matches) closeDrawer(); };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [closeDrawer]);
  useEffect(closeDrawer, [location.key, closeDrawer]);
  useEffect(() => {
    if (!drawerOpen) return;
    aside.current?.querySelector<HTMLElement>('button:not(:disabled), a[href], summary')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (event.key === "Escape" && !document.querySelector('[popover]:popover-open')) closeDrawer();
      if (event.key !== "Tab") return;
      const items = [...(aside.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, summary, [tabindex="0"]') || [])].filter(item => !item.closest('[inert]') && item.getClientRects().length);
      const target = event.shiftKey ? items.at(-1) : items[0];
      if (!aside.current?.contains(document.activeElement) || document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) { event.preventDefault(); target?.focus(); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [drawerOpen, closeDrawer]);
  function toggle() {
    if (!collapsed && aside.current?.contains(document.activeElement)) root.current?.querySelector<HTMLButtonElement>('.desktop-sidebar-toggle')?.focus();
    setCollapsed(value => !value);
  }
  return <div ref={root} className={`workspace-shell${desktop ? " desktop-shell" : ""}${collapsed ? " sidebar-collapsed" : ""}${drawerOpen ? " drawer-open" : ""} ${className}`}>
    <a className="skip-link" href="#main-content" inert={drawerOpen}>Skip to content</a>
    <WindowChrome history={history} collapsed={collapsed} onToggle={toggle}/>
    <button type="button" className="icon-button mobile-menu" aria-label="Open navigation" aria-controls="workspace-navigation" aria-expanded={drawerOpen} tabIndex={drawerOpen ? -1 : 0} onClick={() => setDrawerOpen(true)}><Icon name="menu"/></button>
    {drawerOpen && <button className="nav-scrim" aria-label="Close navigation" tabIndex={-1} onClick={closeDrawer}/>}
    <aside ref={aside} id="workspace-navigation" className={`sidebar${drawerOpen ? " is-open" : ""}`} role={drawerOpen ? "dialog" : undefined} aria-modal={drawerOpen || undefined} aria-label={sidebar.label} inert={hidden}>
      <div className="sidebar-body">{sidebar.content}</div>
    </aside>
    <motion.div className="workspace-main" ref={scrollRef} inert={drawer && drawerOpen} layout={!reduced && !drawer ? "position" : false} transition={{ layout: { duration: .22, ease: [.2, .8, .2, 1] } }}>{children}</motion.div>
  </div>;
}

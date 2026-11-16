import type { ReactNode } from "react";
import { Icon } from "./ui";

export type ShellHistory = { canBack: boolean; canForward: boolean; back(): void; forward(): void };
export type WorkspaceSidebarOverride = { label: string; content: ReactNode };

export function WindowChrome({ history, collapsed, onToggle }: { history?: ShellHistory; collapsed: boolean; onToggle(): void }) {
  return <div className="window-chrome desktop-window-controls">
    {history && <div className="desktop-history" role="group" aria-label="Page history"><button type="button" className="icon-button" aria-label="Back" title="Back" aria-keyshortcuts="Alt+ArrowLeft Meta+[" disabled={!history.canBack} onClick={history.back}><Icon name="arrow"/></button><button type="button" className="icon-button" aria-label="Forward" title="Forward" aria-keyshortcuts="Alt+ArrowRight Meta+]" disabled={!history.canForward} onClick={history.forward}><Icon name="arrow"/></button></div>}
    <button type="button" className="icon-button desktop-sidebar-toggle" aria-label={collapsed ? "Show navigation" : "Hide navigation"} aria-controls="workspace-navigation" aria-expanded={!collapsed} onClick={onToggle}><Icon name="sidebar"/></button>
  </div>;
}

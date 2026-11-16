import { useRef, useState } from "react";
import { Link } from "react-router";
import type { Activity } from "../../shared/contracts";
import { time, useApi, videoPath } from "./api";
import { Icon, Notice } from "./ui";
import { Popover } from "./popover";

export function NotificationsMenu({ connected, onConnectWorkspace }: { connected: boolean; onConnectWorkspace?: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="notifications-control"><button type="button" className="icon-button" aria-label="Notifications" title="Notifications" aria-haspopup="dialog" aria-expanded={open} ref={trigger} onClick={() => setOpen(value => !value)}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></button><Popover open={open} anchor={trigger} label="Notifications" onClose={() => setOpen(false)} className="notifications-popover"><header><h2>Notifications</h2><button type="button" className="icon-button" aria-label="Close notifications" onClick={() => { setOpen(false); trigger.current?.focus(); }}><Icon name="close" size={15}/></button></header>{connected ? <ActivityList close={() => setOpen(false)}/> : <div className="notifications-empty"><p>Connect your workspace to see activity on your videos and conversations.</p>{onConnectWorkspace && <button type="button" className="button" onClick={() => { setOpen(false); onConnectWorkspace(); }}>Connect workspace</button>}</div>}</Popover></div>;
}

function ActivityList({ close }: { close: () => void }) {
  const { data, error, loading, reload } = useApi<{ activity: Activity[] }>("/api/activity");
  const verbs: Record<Activity["kind"], string> = { view: "viewed", comment: "commented on", reply: "replied on", video: "shared" };
  return <><div className="notifications-refresh"><span>Recent activity</span><button type="button" className="text-button" disabled={loading} onClick={reload}>Refresh</button></div>{error && <Notice error>{error}<button type="button" className="text-button" onClick={reload}>Try again</button></Notice>}{loading && !data && <p className="notifications-empty" role="status">Loading notifications…</p>}{!loading && !error && !data?.activity.length && <p className="notifications-empty" role="status">No notifications yet.</p>}{data && <div className="notifications-list">{data.activity.map(item => <Link className="notification-item" key={item.id} to={videoPath(item.videoId, item.positionMs)} onClick={close}><span className="notification-symbol"><Icon name={item.kind === "view" || item.kind === "video" ? "video" : "comment"} size={16}/></span><div><p><strong>{item.actorName}</strong> {verbs[item.kind]} <strong>{item.videoTitle}</strong></p>{item.body && <p className="notification-body">{item.body}</p>}<small><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>{item.positionMs !== null && <span> · {time(item.positionMs)}</span>}</small></div></Link>)}</div>}</>;
}

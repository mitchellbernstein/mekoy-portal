import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { Popover } from "./popover";
import { useNavigate, useSearchParams } from "react-router";
import type { Bootstrap, Comment, Video, VideoDetail } from "../../shared/contracts";
import { date, errorMessage, time, useApi, videoPath, workspaceOrigin, write } from "./api";
import { Avatar, Icon, Modal, Notice } from "./ui";
import { MediaPlayer, type MediaPlayerMarker, type PlayerHandle } from "./player";
import { FreeShareDialog } from "./free-share";
import "../comment-polish.css";

export type RunAction = (key: string, operation: () => Promise<unknown>) => Promise<boolean>;
const emojis = ["👍", "❤️", "🎉", "🚀", "👀"];
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function isEmoji(body: string) {
  const text = body.trim();
  return Array.from(graphemes.segment(text)).length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(text);
}

export function VideoPage({ id, bootstrap, titleTarget, toolbarTarget, panelTarget }: { id: string; bootstrap: Bootstrap; titleTarget: HTMLSpanElement | null; toolbarTarget: HTMLDivElement | null; panelTarget: HTMLDivElement | null }) {
  const { data, error: loadError, reload } = useApi<VideoDetail>(`/api/videos/${encodeURIComponent(id)}`);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const player = useRef<PlayerHandle>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const recordedView = useRef(false);
  const deleted = useRef(false);
  const pendingSeek = useRef(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [tab, setTab] = useState<"comments" | "transcript">("comments");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [title, setTitle] = useState("");
  const [dialog, setDialog] = useState<"edit" | "share" | "delete" | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionTrigger = useRef<HTMLButtonElement>(null);
  const video = data?.video;
  useEffect(() => { setTitle(video?.title || ""); }, [video?.title]);
  const total = duration || video?.durationMs || 0;
  const activeWord = data?.words.findIndex(word => word.startMs <= position && word.endMs > position) ?? -1;

  useEffect(() => {
    const requested = Number(params.get("t") || 0);
    pendingSeek.current = Number.isFinite(requested) && requested >= 0 ? requested : 0;
    if (player.current) seek(pendingSeek.current);
  }, [params]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") reload(); }, 15000);
    return () => window.clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    if (tab === "transcript" && activeWord >= 0) transcript.current?.querySelector<HTMLElement>("[aria-current=true]")?.scrollIntoView({ block: "nearest" });
  }, [activeWord, tab]);

  function seek(ms: number) {
    const next = Math.max(0, Math.min(ms, total || ms));
    pendingSeek.current = next;
    player.current?.seek(next);
    setPosition(next);
  }
  async function recordView() {
    if (recordedView.current) return;
    recordedView.current = true;
    const key = `video-view:${bootstrap.user.id}:${id}`;
    let eventId: string = crypto.randomUUID();
    try { eventId = sessionStorage.getItem(key) || eventId; sessionStorage.setItem(key, eventId); } catch { /* Private browser storage can be unavailable. */ }
    try { await write(`/api/videos/${encodeURIComponent(id)}/views`, "POST", { eventId }); reload(); }
    catch (failure) { recordedView.current = false; setError(`Your view couldn’t be saved. ${errorMessage(failure)}`); }
  }
  const run: RunAction = async (key, operation) => {
    setBusy(key); setError("");
    try { await operation(); reload(); return true; }
    catch (failure) { setError(errorMessage(failure)); return false; }
    finally { setBusy(""); }
  };
  async function deleteVideo() {
    setBusy("delete"); setError("");
    try { await write(`/api/videos/${encodeURIComponent(id)}`, "DELETE"); deleted.current = true; setDialog(null); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(""); }
  }

  if (loadError) return <div className="video-load-error"><h1>This recording couldn’t load</h1><Notice error>{loadError}</Notice><button className="button" onClick={reload}>Try again</button></div>;
  if (!data || !video) return <div className="loading-state"><span className="spinner" />Loading recording…</div>;

  const owner = video.ownerId === bootstrap.user.id;
  const processing = ["processing", "queued", "running", "pending", "transcribing", "summarizing"].includes(data.processing.status);
  const rename = (next: string) => run("rename", async () => {
    const result = await write<{ video: Video }>(`/api/videos/${encodeURIComponent(id)}`, "PATCH", { title: next });
    setTitle(result.video.title);
  });
  const children = new Map<string, Comment[]>();
  const known = new Set(data.comments.map(comment => comment.id));
  const roots: Comment[] = [];
  const points = new Map<number, Comment[]>();
  for (const comment of data.comments) {
    if (comment.parentId && known.has(comment.parentId)) {
      const replies = children.get(comment.parentId) || [];
      replies.push(comment); children.set(comment.parentId, replies);
    } else roots.push(comment);
    if (!comment.deletedAt) {
      const entries = points.get(comment.positionMs) || [];
      entries.push(comment); points.set(comment.positionMs, entries);
    }
  }
  const markers: MediaPlayerMarker[] = [...points].sort(([a], [b]) => a - b).map(([positionMs, entries]) => ({
    positionMs, count: entries.length,
    label: entries.map(comment => `${comment.authorName}: ${comment.body}`).join("; "),
    ...(entries.every(comment => isEmoji(comment.body)) ? { emoji: entries[0].body } : {}),
  }));

  return <>
    {titleTarget && createPortal(<VideoTitle title={title || video.title} owner={owner} busy={!!busy} onSave={rename} location="breadcrumb" />, titleTarget)}
    {toolbarTarget && createPortal(<>
      {data.viewers.total > 0 && <div className="video-viewers" role="group" aria-label={`${data.viewers.total} ${data.viewers.total === 1 ? "viewer" : "viewers"}`}><div className="viewer-stack">{data.viewers.items.slice(0, 5).map(viewer => <span className="viewer-avatar" title={viewer.name} key={viewer.id}><Avatar name={viewer.name} image={viewer.image} small /><span className="sr-only">{viewer.name}</span></span>)}{data.viewers.total > 5 && <span className="viewer-overflow">+{data.viewers.total - 5}<span className="sr-only"> more viewers</span></span>}</div></div>}
      {(bootstrap.account.canOrganize||owner)&&<button className="button primary toolbar-share" onClick={() => setDialog("share")}><Icon name="share" size={16} />Share</button>}
      {owner && <div className="video-action-menu"><button type="button" ref={actionTrigger} className="icon-button" aria-label="Video actions" aria-haspopup="dialog" aria-expanded={actionsOpen} onClick={() => setActionsOpen(value => !value)}><Icon name="more" size={20}/></button><Popover open={actionsOpen} anchor={actionTrigger} label="Video actions" className="video-action-popover" onClose={() => setActionsOpen(false)}><button type="button" onClick={() => { setActionsOpen(false); actionTrigger.current?.focus(); setDialog("edit"); }}><Icon name="edit" size={16}/>Edit details</button><button type="button" className="danger" disabled={!!busy} onClick={() => { setActionsOpen(false); actionTrigger.current?.focus(); setError(""); setDialog("delete"); }}><Icon name="trash" size={16}/>Delete video</button></Popover></div>}
    </>, toolbarTarget)}
    {panelTarget && createPortal(<div className="discussion-tabs" role="tablist" aria-label="Discussion panels">
        <button role="tab" id="comments-tab" aria-controls="comments-panel" aria-selected={tab === "comments"} tabIndex={tab === "comments" ? 0 : -1} className={tab === "comments" ? "active" : ""} onClick={() => setTab("comments")} onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setTab("transcript"); document.getElementById("transcript-tab")?.focus(); } }}>Comments<span>{data.comments.filter(comment => !comment.deletedAt).length}</span></button>
        <button role="tab" id="transcript-tab" aria-controls="transcript-panel" aria-selected={tab === "transcript"} tabIndex={tab === "transcript" ? 0 : -1} className={tab === "transcript" ? "active" : ""} onClick={() => setTab("transcript")} onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setTab("comments"); document.getElementById("comments-tab")?.focus(); } }}>Transcript</button>
      </div>, panelTarget)}
    <div className="video-page">
    <section className="playback-column" aria-label="Video playback">
      <header className="video-heading"><div><h1><VideoTitle title={title || video.title} owner={owner} busy={!!busy} onSave={rename} location="heading" /></h1><p><Avatar name={video.ownerName} small />{video.ownerName}<span>·</span>{date(video.createdAt)}<span>·</span>{time(total)}<span className="visibility-label"><Icon name={video.teamId ? "team" : "video"} size={14} />{video.teamId ? bootstrap.teams.find(team => team.id === video.teamId)?.name || "Team" : bootstrap.account.canOrganize ? "Personal recording" : "7-day link sharing"}</span>{video.agentRunId && <span className="source-badge">Demo agent</span>}</p></div></header>
      {error && <Notice error>{error}</Notice>}
      <div className="player-frame">{video.uploadState === "uploaded" ? <MediaPlayer key={video.id} ref={player} video={video} playbackUrl={`/api/videos/${encodeURIComponent(video.id)}/playback`} position={position} duration={total} markers={markers} chapters={video.chapters} onSeek={seek} onTimeUpdate={ms => { pendingSeek.current = ms; setPosition(ms); }} onPlay={recordView} onDuration={setDuration} onError={setMediaError} onReady={() => { setMediaError(""); seek(pendingSeek.current); }} /> : <div className="pending-video"><Icon name="upload" size={34} /><h2>This upload isn’t complete yet</h2><p>Finish or retry the upload from the device that recorded it. Keep your original file.</p></div>}</div>
      {mediaError && <Notice error>{mediaError}</Notice>}
    </section>
    <aside className="discussion-column" aria-label="Comments and transcript">
      {tab === "comments" ? <div role="tabpanel" id="comments-panel" aria-labelledby="comments-tab" className="comments-panel">
        {!data.comments.some(comment => comment.source === "summary") && <div className="summary-status" role="status"><p>{processing ? "Preparing the video summary…" : data.processing.status === "not_configured" || data.processing.status === "needs_setup" ? "AI summaries need setup. Ask your server owner to enable transcription and summaries." : "Video summary is not available yet."}</p></div>}
        <div className="comment-list">{!roots.some(comment => !comment.deletedAt || children.has(comment.id)) && <div className="empty-discussion"><Icon name="comment" size={24} /><h3>Start the conversation</h3><p>Leave a comment or an emoji at this moment.</p></div>}{roots.map(comment => <CommentThread key={comment.id} comment={comment} childrenByParent={children} userId={bootstrap.user.id} ownerId={video.ownerId} videoId={id} seek={seek} busy={!!busy} run={run} />)}</div>
        <CommentComposer id="new-comment" label="Add a comment" position={Math.round(position)} busy={!!busy} onSubmit={body => run("comment", () => write(`/api/videos/${encodeURIComponent(id)}/comments`, "POST", { body, positionMs: Math.round(position) }))} />

      </div> : <div role="tabpanel" id="transcript-panel" aria-labelledby="transcript-tab" className="transcript-panel" ref={transcript}>{data.words.length ? <><p className="transcript-help">Click a word to jump to that moment.</p><p className="transcript-words">{data.words.map((word, index) => <span key={`${word.startMs}-${index}`}><button className={index === activeWord ? "active-word" : ""} aria-current={index === activeWord ? "true" : undefined} aria-label={`${word.word}, ${time(word.startMs)}`} title={time(word.startMs)} onClick={() => seek(word.startMs)}>{word.word}</button>{" "}</span>)}</p></> : <div className="empty-discussion"><Icon name="video" size={24} /><h3>No transcript yet</h3><p>Word timings will appear after this recording is transcribed.</p>{owner && <button className="button" disabled={!!busy} onClick={() => run("process", () => write(`/api/videos/${encodeURIComponent(id)}/process`, "POST"))}>Process recording</button>}</div>}</div>}
      {data.slack.threadUrl && <a className="slack-thread-link" href={data.slack.threadUrl} target="_blank" rel="noreferrer"><Icon name="slack" size={16} />Open conversation in Slack<Icon name="arrow" size={14} /></a>}
    </aside>
    <AnimatePresence onExitComplete={() => { if (deleted.current) navigate("/my-videos"); }}>{dialog === "edit" && <VideoDetailsDialog key="edit" video={video} bootstrap={bootstrap} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); reload(); }} />}
    {dialog === "share" && (owner&&!video.teamId&&(!bootstrap.account.canOrganize||data.shareLink)?<FreeShareDialog key="free-share" videoId={video.id} canIssue={!bootstrap.account.canOrganize} onClose={()=>setDialog(null)}/>:<ShareDialog key="share" detail={data} bootstrap={bootstrap} position={Math.round(position)} onClose={() => setDialog(null)} onShared={reload} />)}
    {dialog === "delete" && <Modal key="delete" title="Delete this video?" onClose={() => setDialog(null)} busy={!!busy}><p className="form-intro">It will disappear from the workspace and its links will stop working.</p>{error && <Notice error>{error}</Notice>}<footer className="modal-footer"><button className="button" disabled={!!busy} onClick={() => setDialog(null)}>Cancel</button><button className="button danger-button" disabled={!!busy} onClick={deleteVideo}>{busy === "delete" ? "Deleting…" : "Delete video"}</button></footer></Modal>}</AnimatePresence>
    </div>
  </>;
}

function VideoTitle({ title, owner, busy, onSave, location }: { title: string; owner: boolean; busy: boolean; onSave: (title: string) => Promise<boolean>; location: "heading" | "breadcrumb" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  if (!owner) return <span>{title}</span>;
  return editing ? <input className="video-title-input" aria-label={`Video title in ${location}`} value={draft} maxLength={240} autoFocus disabled={busy} onFocus={event => event.target.select()} onChange={event => setDraft(event.target.value)} onBlur={() => setEditing(false)} onKeyDown={async event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
    if (event.key === "Enter") {
      event.preventDefault();
      const next = draft.trim();
      if (!next || next === title) { setEditing(false); return; }
      if (await onSave(next)) setEditing(false);
    }
  }} /> : <button type="button" className="video-title-label" aria-label={`Rename video in ${location}`} title="Click to rename" disabled={busy} onClick={() => { setDraft(title); setEditing(true); }}>{title}</button>;
}

export function CommentComposer({ id, label, position, busy, onSubmit, onCancel }: { id: string; label: string; position: number; busy: boolean; onSubmit: (body: string) => Promise<boolean>; onCancel?: () => void }) {
  const [body, setBody] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (body.trim() && await onSubmit(body.trim())) { setBody(""); setEmojiOpen(false); }
  }
  return <form className={onCancel ? "reply-form" : "comment-composer"} onSubmit={submit}>
    <div className="comment-input">
    <label className="sr-only" htmlFor={id}>{label}</label><textarea ref={textarea} id={id} autoFocus={!!onCancel} required maxLength={10000} placeholder={onCancel ? "Write a reply or emoji…" : "Add a comment or emoji…"} value={body} onChange={event => setBody(event.target.value)} disabled={busy} />
    {emojiOpen && <div className="emoji-picker" role="group" aria-label="Emoji choices">{emojis.map(emoji => <button type="button" key={emoji} disabled={busy} aria-label={`Add ${emoji} to comment`} onClick={() => { setBody(previous => previous + emoji); setEmojiOpen(false); textarea.current?.focus(); }}>{emoji}</button>)}</div>}
    <div className="composer-actions"><div className="composer-context"><span className="composer-time" aria-label={`Comment at ${time(position)}`}>{time(position)}</span><button type="button" className="emoji-toggle" aria-label="Add emoji" aria-expanded={emojiOpen} onClick={() => setEmojiOpen(!emojiOpen)} disabled={busy}><span aria-hidden="true">☺</span></button></div><div className="composer-submit">{onCancel && <button type="button" className="text-button" onClick={onCancel} disabled={busy}>Cancel</button>}<button type="submit" className="button primary composer-send" aria-label={busy ? "Posting…" : onCancel ? "Post reply" : "Post comment"} title={onCancel ? "Post reply" : "Post comment"} disabled={busy || !body.trim()}>{busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={18} />}</button></div></div>
    </div>
  </form>;
}

type ThreadProps = { comment: Comment; childrenByParent: Map<string, Comment[]>; userId: string; ownerId: string; videoId: string; seek: (ms: number) => void; busy: boolean; run: RunAction };
export function CommentThread(props: ThreadProps) {
  const { comment, childrenByParent, userId, ownerId, videoId, seek, busy, run } = props;
  const [replying, setReplying] = useState(false);
  const replies = childrenByParent.get(comment.id) || [];
  return <AnimatePresence propagate>{(!comment.deletedAt || replies.length > 0) && <article key={comment.id} className={`comment-thread${comment.source === "summary" ? " opening-summary" : ""}`}>
    <CommentItem comment={comment} userId={userId} ownerId={ownerId} seek={seek} busy={busy} run={run} onReply={() => setReplying(!replying)} />
    {replies.length > 0 && <div className="replies">{replies.map(reply => <CommentThread key={reply.id} {...props} comment={reply} />)}</div>}
    {replying && <CommentComposer id={`reply-${comment.id}`} label={`Reply to ${comment.authorName}`} position={comment.positionMs} busy={busy} onCancel={() => setReplying(false)} onSubmit={async body => {
      const saved = await run(`reply-${comment.id}`, () => write(`/api/videos/${encodeURIComponent(videoId)}/comments`, "POST", { body, parentId: comment.id, positionMs: comment.positionMs }));
      if (saved) setReplying(false);
      return saved;
    }} />}
  </article>}</AnimatePresence>;
}

function CommentItem({ comment, userId, ownerId, seek, busy, run, onReply }: { comment: Comment; userId: string; ownerId: string; seek: (ms: number) => void; busy: boolean; run: RunAction; onReply: () => void }) {
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const [draft, setDraft] = useState(comment.body);
  const [deleteError, setDeleteError] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionTrigger = useRef<HTMLButtonElement>(null);
  const authored = comment.authorId === userId && (comment.source === "web" || comment.source === "summary");
  const canDelete = authored || comment.source === "agent" && ownerId === userId;
  return <div className="comment-item"><Avatar name={comment.authorName} /><div className="comment-content">
    <div className="comment-meta"><strong>{comment.authorName}</strong>{comment.source !== "web" && <span className="source-badge" title={comment.source === "summary" ? "Generated from the recording" : undefined}>{comment.source === "summary" ? "AI summary" : comment.source === "agent" ? "Agent" : "Slack"}</span>}<span className="meta-dot">·</span><button className="timestamp" onClick={() => seek(comment.positionMs)}>{time(comment.positionMs)}</button>
      {canDelete && !comment.deletedAt && <div className="comment-menu"><button type="button" ref={actionTrigger} className="comment-action-trigger" aria-label="Comment actions" aria-haspopup="dialog" aria-expanded={actionsOpen} onClick={() => setActionsOpen(value => !value)}>•••</button><Popover open={actionsOpen} anchor={actionTrigger} label="Comment actions" className="comment-action-popover" onClose={() => setActionsOpen(false)}>{authored && <button type="button" disabled={busy} onClick={() => { setActionsOpen(false); actionTrigger.current?.focus(); setDraft(comment.body); setDialog("edit"); }}>Edit</button>}<button type="button" className="danger" disabled={busy} onClick={() => { setActionsOpen(false); actionTrigger.current?.focus(); setDeleteError(""); setDialog("delete"); }}>Delete</button></Popover></div>}
    </div>
    {dialog === "edit" ? <form className="edit-comment-form" onSubmit={async event => { event.preventDefault(); if (await run(`edit-${comment.id}`, () => write(`/api/comments/${encodeURIComponent(comment.id)}`, "PATCH", { body: draft.trim() }))) setDialog(null); }}><label className="sr-only" htmlFor={`edit-${comment.id}`}>Edit comment</label><textarea id={`edit-${comment.id}`} autoFocus value={draft} required maxLength={10000} disabled={busy} onChange={event => setDraft(event.target.value)} /><div><button type="button" className="text-button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="button primary compact" disabled={busy || !draft.trim()}>Save</button></div></form> : <p className={comment.deletedAt ? "deleted-comment" : `comment-body${isEmoji(comment.body) ? " emoji-comment" : ""}`}>{comment.deletedAt ? "This comment was deleted." : comment.body}</p>}
    {!comment.deletedAt && <>{comment.summaryMoments?.length ? <ul className="summary-moments">{comment.summaryMoments.map((moment, index) => <li key={`${moment.positionMs}-${index}`}><button className="timestamp" onClick={() => seek(moment.positionMs)}>{time(moment.positionMs)}</button><span>{moment.text}</span></li>)}</ul> : null}<div className="comment-actions"><button className="text-button" onClick={onReply}>Reply</button>{comment.updatedAt !== comment.createdAt && <span>Edited</span>}</div></>}
    <AnimatePresence propagate>{dialog === "delete" && <Modal key="delete-comment" title="Delete this comment?" onClose={() => setDialog(null)} busy={busy}><p className="form-intro">This comment will be deleted. Replies will stay in the conversation.</p>{deleteError && <Notice error>{deleteError}</Notice>}<footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button type="button" className="button danger-button" disabled={busy} onClick={async () => { setDeleteError(""); if (await run(`delete-${comment.id}`, () => write(`/api/comments/${encodeURIComponent(comment.id)}`, "DELETE"))) setDialog(null); else setDeleteError("This comment couldn’t be deleted. Try again."); }}>{busy ? "Deleting…" : "Delete comment"}</button></footer></Modal>}</AnimatePresence>
  </div></div>;
}

function VideoDetailsDialog({ video, bootstrap, onClose, onSaved }: { video: Video; bootstrap: Bootstrap; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(video.title);
  const [teamId, setTeamId] = useState(video.teamId || "");
  const [folderId, setFolderId] = useState(video.folderId || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Modal title="Video details" onClose={onClose} busy={busy}><form className="stack-form" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try { await write(`/api/videos/${encodeURIComponent(video.id)}`, "PATCH", { title: title.trim(), ...(bootstrap.account.canOrganize?{teamId:teamId||null,folderId:folderId||null}:{}) }); onSaved(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}><label>Title<input required value={title} maxLength={240} onChange={event => setTitle(event.target.value)} disabled={busy} /></label>{bootstrap.account.canOrganize?<><label>Who can watch<select value={teamId} onChange={event => { setTeamId(event.target.value); setFolderId(""); }} disabled={busy}><option value="">Personal recording</option>{bootstrap.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><p className="form-help">{teamId ? "Everyone in the selected team can watch and join the conversation." : "Personal recordings open through your workspace link. An active viewing link can also allow anyone to watch until it expires."}</p><label>Folder<select value={folderId} onChange={event => setFolderId(event.target.value)} disabled={busy}><option value="">No folder</option>{bootstrap.folders.filter(folder => (folder.teamId || "") === teamId).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label></>:<p className="form-help">Teams and folders require a workspace account. Ask the server owner to enable organization.</p>}{error && <Notice error>{error}</Notice>}<footer className="modal-footer"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !title.trim()}>{busy ? "Saving…" : "Save changes"}</button></footer></form></Modal>;
}

function ShareDialog({ detail, bootstrap, position, onClose, onShared }: { detail: VideoDetail; bootstrap: Bootstrap; position: number; onClose: () => void; onShared: () => void }) {
  const [includeTime, setIncludeTime] = useState(false);
  const [copied, setCopied] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [threadUrl, setThreadUrl] = useState(detail.slack.threadUrl);
  const team = bootstrap.teams.find(item => item.id === detail.video.teamId);
  const link = `${workspaceOrigin()}${videoPath(detail.video.id, includeTime ? position : null)}`;
  return <Modal title="Share this recording" onClose={onClose} busy={busy}><p className="form-intro">{team ? `People in ${team.name} can watch this video.` : "Use the workspace link to open this personal recording. Active viewing links can also grant access until they expire."}</p><label className="field-label" htmlFor="share-link">Video link</label><div className="copy-link"><input id="share-link" value={link} readOnly onFocus={event => event.target.select()} /><button className="button primary" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setError("Select and copy the link above. Clipboard access is unavailable in this browser."); } }}>{copied ? <><Icon name="check" size={16} />Copied</> : "Copy link"}</button></div><label className="checkbox-label"><input type="checkbox" checked={includeTime} onChange={event => { setIncludeTime(event.target.checked); setCopied(false); }} />Start at {time(position)}</label>{(bootstrap.account.canOrganize||threadUrl)&&<section className="slack-share">{bootstrap.account.canOrganize&&<><h3><Icon name="slack" size={19} />Share to Slack</h3>{!team ? <p>Choose a team in video details to share this recording in a Slack thread.</p> : <><p>{detail.slack.connected ? "Share to a channel the connected Slack app can access. Replies stay together in one thread." : "Connect this team’s Slack workspace, then share to a channel. Slack installation does not change who can watch."}</p>{!detail.slack.connected && team.role === "owner" && <a className="button" href={`${workspaceOrigin()}/api/slack/connect?teamId=${encodeURIComponent(team.id)}`}><Icon name="slack" size={17} />Connect Slack</a>}{!detail.slack.connected && team.role !== "owner" && <p className="form-help">Ask a team owner to connect Slack.</p>}<p className="provider-setup">{bootstrap.capabilities.slack}</p><form className="stack-form" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); setStatus(""); try { const result = await write<{ status: string; threadUrl?: string }>(`/api/videos/${encodeURIComponent(detail.video.id)}/slack`, "POST", { channelId: channelId.trim() }); setStatus(result.status === "uncertain" ? "Slack did not confirm the result. Check the channel before trying again." : result.threadUrl ? "Shared to Slack." : result.status); if (result.threadUrl) setThreadUrl(result.threadUrl); onShared(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}><label>Slack channel ID<input required placeholder="C0123456789" value={channelId} onChange={event => setChannelId(event.target.value)} disabled={busy} /></label><p className="form-help">Open the channel details in Slack to copy its channel ID.</p><button className="button" disabled={busy || !channelId.trim()}>{busy ? "Sharing…" : "Share to Slack"}<Icon name="arrow" size={16} /></button></form></>}</>}{threadUrl && <div className="thread-controls"><a className="text-button thread-result" href={threadUrl} target="_blank" rel="noreferrer">Open Slack thread<Icon name="arrow" size={15} /></a>{detail.video.ownerId === bootstrap.user.id && <button className="text-button danger" disabled={busy} onClick={async () => {
    if (!window.confirm("Disconnect this video from its Slack thread? Existing Slack messages will remain, and future comments will stop syncing to this thread.")) return;
    setBusy(true); setError(""); setStatus("");
    try { await write(`/api/videos/${encodeURIComponent(detail.video.id)}/slack`, "DELETE"); setThreadUrl(null); setStatus("Slack thread disconnected. Existing messages remain in Slack."); onShared(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }}>Disconnect thread</button>}</div>}</section>}{status && <Notice>{status}</Notice>}{(error || detail.slack.error) && <Notice error>{error || detail.slack.error}</Notice>}</Modal>;
}

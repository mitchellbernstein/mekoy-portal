import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { AnimatePresence } from "motion/react";
import type { Bootstrap, Comment, FeedPost, LibraryData, Team, Video } from "../../shared/contracts";
import type { SharedMeetingNoteListItem } from "../../shared/meeting-notes";
import { date, errorMessage, time, useApi, videoPath, workspaceOrigin, write, type ApiSeed } from "./api";
import { Avatar, Empty, Icon, Modal, Notice } from "./ui";
import { MediaPlayer, type MediaPlayerMarker, type PlayerHandle } from "./player";
import { CommentComposer, CommentThread, isEmoji, type RunAction } from "./video";
import { sharedNotesPath, SharedNotesCollection, SharedNotesError, TeamNoteCard, type SharedNotesData } from "./team-notes";
import "../feed-polish.css";
import { CardPreview } from "./card-preview";

export type LibraryScope = "home" | "mine" | "team" | "folder";
export type { LibraryData } from "../../shared/contracts";

export function libraryPath(scope: LibraryScope, id?: string) {
  return scope === "home" ? "/api/feed" : `/api/videos?scope=${scope}${id ? `&id=${encodeURIComponent(id)}` : ""}`;
}

export function LibraryPage({ bootstrap, scope, id, onUpload, initialData }: { bootstrap: Bootstrap; scope: LibraryScope; id?: string; onUpload: () => void; initialData?: ApiSeed<LibraryData> | null }) {
  const team = bootstrap.teams.find(item => item.id === id);
  const folder = bootstrap.folders.find(item => item.id === id);
  const { data, error, loading, reload } = useApi<LibraryData>(libraryPath(scope, id), initialData);
  const [membersOpen, setMembersOpen] = useState(false);
  const title = scope === "mine" ? "My videos" : scope === "team" ? team?.name || "Team" : scope === "folder" ? folder?.name || "Folder" : "Home";
  const description = scope === "mine" ? "Your recordings, newest first." : scope === "team" ? "Videos and written notes shared with your team." : scope === "folder" ? "Videos and written notes in this folder." : "Shared recordings, workspace notes, and the conversations around them.";
  const posts = data && "posts" in data ? data.posts : null;
  const videos = data && "videos" in data ? data.videos : null;
  return (
    <div className={`library-page${scope === "home" ? " home-page" : " collection-page"}`}>
      <header className="page-heading"><div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{scope === "team" && team && <>{team.role === "owner" && <button className="button" onClick={() => setMembersOpen(true)}><Icon name="team" size={17} />Members</button>}{bootstrap.account.canOrganize&&<a className="button" href={`/api/slack/connect?teamId=${encodeURIComponent(team.id)}`}><Icon name="slack" size={17} />{team.role === "owner" ? "Connect Slack" : "Link Slack account"}</a>}</>}{(scope!=="team"||bootstrap.account.canOrganize)&&<button className="button primary" onClick={onUpload}><Icon name="upload" size={17} />Upload video</button>}</div></header>
      {scope === "team" && bootstrap.account.canOrganize && <p className="team-provider-status">{bootstrap.capabilities.slack}</p>}
      {scope !== "home" && error && <Notice error>{error}<button className="text-button" onClick={reload}>Try again</button></Notice>}
      {scope !== "home" && loading && !data && <div className="loading-state"><span className="spinner" />Loading videos…</div>}
      {scope === "mine" && (posts || videos)?.length === 0 && <Empty title="No videos yet" action={<button className="button primary" onClick={onUpload}><Icon name="upload" size={17} />Upload your first video</button>}>Upload a recording to start a conversation.</Empty>}
      {scope === "home" && <WorkspaceFeed bootstrap={bootstrap} posts={posts || []} videosLoading={loading && !data} videosError={error} reloadVideos={reload}/>}
      {scope !== "home" && !!posts?.length && <section className="video-feed" aria-label="Video posts">{posts.map(post => <VideoPost key={post.video.id} post={post} bootstrap={bootstrap} reload={reload} />)}</section>}
      {videos && (videos.length > 0 || scope === "team" || scope === "folder") && <section aria-label="Videos"><div className="section-heading"><h2>Videos</h2><span>{videos.length} {videos.length === 1 ? "video" : "videos"}</span></div>{videos.length ? <div className="video-grid collection-grid">{videos.map(video => <VideoCard key={video.id} video={video} bootstrap={bootstrap} />)}</div> : <p className="collection-empty-media">No videos in this {scope} yet.</p>}</section>}
      {(scope === "team" || scope === "folder") && id && <SharedNotesCollection scope={scope} id={id}/>}
      <AnimatePresence>{membersOpen && team && <MembersDialog key={team.id} canAdd={bootstrap.account.canOrganize} team={team} currentUserId={bootstrap.user.id} onClose={() => setMembersOpen(false)} />}</AnimatePresence>
    </div>
  );
}

type WorkspacePost = { kind: "video"; post: FeedPost; updatedAt: number } | { kind: "note"; note: SharedMeetingNoteListItem; updatedAt: number };

export function WorkspaceFeed({ bootstrap, posts, videosLoading, videosError, reloadVideos }: { bootstrap: Bootstrap; posts: FeedPost[]; videosLoading: boolean; videosError: string; reloadVideos: () => void }) {
  const notes = useApi<SharedNotesData>(sharedNotesPath("feed"));
  const items: WorkspacePost[] = [
    ...posts.map(post => ({ kind: "video" as const, post, updatedAt: Math.max(Date.parse(post.video.createdAt), ...post.comments.map(comment => Date.parse(comment.deletedAt || comment.updatedAt))) })),
    ...(notes.data?.notes || []).map(note => ({ kind: "note" as const, note, updatedAt: Date.parse(note.updatedAt) })),
  ];
  items.sort((a, b) => b.updatedAt - a.updatedAt || (a.kind === "video" ? a.post.video.id : a.note.id).localeCompare(b.kind === "video" ? b.post.video.id : b.note.id));
  return <><div className="workspace-feed-intro"><p>Recent recordings, conversations, and workspace-note excerpts.</p><button type="button" className="text-button" disabled={videosLoading || notes.loading} onClick={() => { reloadVideos(); notes.reload(); }}>Refresh</button></div>
    {videosError && <Notice error>{videosError}<button type="button" className="text-button" onClick={reloadVideos}>Try videos again</button></Notice>}
    {notes.error && <SharedNotesError error={notes.error} reload={notes.reload}/>}
    {(videosLoading || notes.loading && !notes.data) && <p className="workspace-feed-loading" role="status">Loading shared posts…</p>}
    {!items.length && !videosLoading && !notes.loading && !videosError && !notes.error && <div className="empty-state"><h2>No shared posts yet</h2><p>Shared videos and explicitly published team notes will appear here.</p></div>}
    <section className="video-feed workspace-posts" aria-label="Shared workspace posts">{items.map(item => item.kind === "video" ? <VideoPost key={`video-${item.post.video.id}`} post={item.post} bootstrap={bootstrap} reload={reloadVideos}/> : <TeamNoteCard key={`note-${item.note.id}`} note={item.note}/>)}</section>
  </>;
}

export function VideoCard({ video, bootstrap }: { video: Video; bootstrap: Bootstrap }) {
  const link = useRef<HTMLAnchorElement>(null);
  return <Link ref={link} className="video-card grid-card" to={videoPath(video.id)}>
    <div className="video-thumbnail">{video.uploadState === "uploaded" ? <CardPreview videoId={video.id} accountKey={`${workspaceOrigin()}/${bootstrap.user.id}`} link={link}/> : <Icon name="upload" size={26} />}<span className="thumbnail-play"><Icon name="play" size={22} /></span><span className="duration">{time(video.durationMs)}</span></div>
    <div className="video-card-body"><h3>{video.title}</h3><p><Avatar name={video.ownerName} small />{video.ownerName}<span className="meta-dot">·</span>{date(video.createdAt)}</p></div>
    <span className="visibility-label"><Icon name={video.teamId ? "team" : "video"} size={15} />{video.teamId ? bootstrap.teams.find(team => team.id === video.teamId)?.name || "Team" : bootstrap.account.canOrganize ? "Personal recording" : "7-day link sharing"}</span>
    {video.uploadState !== "uploaded" && <span className="status-pill">Upload incomplete</span>}
  </Link>;
}

export function VideoPost({ post, bootstrap, reload }: { post: FeedPost; bootstrap: Bootstrap; reload: () => void }) {
  const { video, comments } = post;
  const frame = useRef<HTMLDivElement>(null);
  const player = useRef<PlayerHandle>(null);
  const viewEvent = useRef<string | null>(null);
  const recordedView = useRef(false);
  const [playerActive, setPlayerActive] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  useEffect(() => {
    if (playerActive) {
      if (document.activeElement === frame.current) frame.current?.querySelector<HTMLElement>(".media-player")?.focus({ preventScroll: true });
      return;
    }
    if (typeof IntersectionObserver !== "function") { setPlayerActive(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setPlayerActive(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, [playerActive]);
  const total = duration || video.durationMs;
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const noReplies = new Map<string, Comment[]>();
  const replyToYou = (comment: Comment) => comment.authorId !== bootstrap.user.id && !!comment.parentId && byId.get(comment.parentId)?.authorId === bootstrap.user.id;
  const summary = comments.find(comment => comment.source === "summary" && comment.authorId === video.ownerId && !comment.deletedAt);
  const recent = comments.filter(comment => !comment.deletedAt && comment.id !== summary?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const personalReply = recent.find(replyToYou);
  const discussion = personalReply ? [personalReply, ...recent.filter(comment => comment.id !== personalReply.id).slice(0, 1)] : recent.slice(0, 2);
  const preview = summary ? [summary, ...discussion] : discussion;
  const moments = new Map<number, Comment[]>();
  for (const comment of comments) {
    if (!comment.deletedAt) {
      const entries = moments.get(comment.positionMs) || [];
      entries.push(comment); moments.set(comment.positionMs, entries);
    }
  }
  const markers: MediaPlayerMarker[] = [...moments].sort(([a], [b]) => a - b).map(([positionMs, entries]) => ({
    positionMs, count: entries.length, label: entries.map(comment => `${comment.authorName}: ${comment.body}`).join("; "),
    ...(entries.every(comment => isEmoji(comment.body)) ? { emoji: entries[0].body } : {}),
  }));
  function seek(ms: number) {
    const next = Math.max(0, Math.min(ms, total || ms));
    setPlayerActive(true);
    player.current?.seek(next); setPosition(next);
  }
  async function recordView() {
    if (recordedView.current) return;
    recordedView.current = true;
    viewEvent.current ||= crypto.randomUUID();
    try { await write(`/api/videos/${encodeURIComponent(video.id)}/views`, "POST", { eventId: viewEvent.current }); }
    catch (failure) { recordedView.current = false; setError(`Your view couldn’t be saved. ${errorMessage(failure)}`); }
  }
  const run: RunAction = async (key, operation) => {
    setBusy(key); setError("");
    try { await operation(); reload(); return true; }
    catch (failure) { setError(errorMessage(failure)); return false; }
    finally { setBusy(""); }
  };
  const commentCount = comments.filter(comment => !comment.deletedAt).length;
  return <article className="feed-post" aria-labelledby={`post-title-${video.id}`}>
    <header className="feed-post-header">
      <Avatar name={video.ownerName} />
      <div className="feed-post-author">
        <p><strong>{video.ownerName}</strong><span>shared a video</span></p>
        <p><time dateTime={video.createdAt}>{date(video.createdAt)}</time><span className="meta-dot">·</span><span className="visibility-label"><Icon name={video.teamId ? "team" : "video"} size={14} />{video.teamId ? bootstrap.teams.find(team => team.id === video.teamId)?.name || "Team" : bootstrap.account.canOrganize ? "Personal recording" : "7-day link sharing"}</span></p>
      </div>
      <Link className="feed-open" to={videoPath(video.id)} aria-label={`Open ${video.title}`} title="Open video"><Icon name="arrow" size={18} /></Link>
    </header>
    <h2 id={`post-title-${video.id}`} className="feed-post-title"><Link to={videoPath(video.id)}>{video.title}</Link></h2>
    <div ref={frame} className="player-frame feed-player" tabIndex={-1}>{playerActive ? <MediaPlayer ref={player} video={video} playbackUrl={`/api/videos/${encodeURIComponent(video.id)}/playback`} position={position} duration={total} markers={markers} chapters={video.chapters} onSeek={seek} onTimeUpdate={setPosition} onPlay={recordView} onDuration={setDuration} onError={setMediaError} onReady={() => { setMediaError(""); seek(position); }} /> : <button type="button" className="pending-video" style={{ width: "100%" }} aria-label={`Load ${video.title} video player`} onFocus={() => { frame.current?.focus({ preventScroll: true }); setPlayerActive(true); }} onClick={() => setPlayerActive(true)}><Icon name="play" size={30} /><span>Load video</span></button>}</div>
    <section className="feed-discussion" aria-label={`Discussion on ${video.title}`}>
      <div className="feed-discussion-heading"><h3>Conversation</h3><span>{commentCount} {commentCount === 1 ? "comment" : "comments"}</span>{commentCount > 0 && <Link className="feed-view-all" to={videoPath(video.id)}>View all comments</Link>}</div>
      {(error || mediaError) && <Notice error>{error || mediaError}</Notice>}
      <div className="comment-list feed-comment-preview">
        {!preview.length && <p className="feed-no-comments">Be the first to leave a comment at a moment in this video.</p>}
        {preview.map(comment => <div key={comment.id} className="feed-preview-item">{comment.parentId && <p className="feed-preview-context">{replyToYou(comment) ? "Reply to you" : `Reply to ${byId.get(comment.parentId)?.authorName || "a comment"}`}</p>}<CommentThread comment={comment} childrenByParent={noReplies} userId={bootstrap.user.id} ownerId={video.ownerId} videoId={video.id} seek={seek} busy={!!busy} run={run} /></div>)}
      </div>
      <CommentComposer id={`new-comment-${video.id}`} label={`Add a comment to ${video.title}`} position={Math.round(position)} busy={!!busy} onSubmit={body => run("comment", () => write(`/api/videos/${encodeURIComponent(video.id)}/comments`, "POST", { body, positionMs: Math.round(position) }))} />
    </section>
  </article>;
}

type Member = { id: string; name: string; email: string; role: "owner" | "member" };

function MembersDialog({ team, currentUserId, canAdd, onClose }: { team: Team; currentUserId: string; canAdd:boolean; onClose: () => void }) {
  const { data, error: loadError, loading, reload } = useApi<{ members: Member[] }>(`/api/teams/${encodeURIComponent(team.id)}/members`);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function add(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try { await write(`/api/teams/${encodeURIComponent(team.id)}/members`, "POST", { email: email.trim() }); setEmail(""); setNotice("Member added. They can now view this team’s videos and notes."); reload(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  async function remove(member: Member) {
    if (!window.confirm(`Remove ${member.name} from ${team.name}? They will lose access to this team’s videos and notes.`)) return;
    setBusy(true); setError(""); setNotice("");
    try { await write(`/api/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`, "DELETE"); setNotice(`${member.name} was removed.`); reload(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title={`${team.name} members`} onClose={onClose} busy={busy}><p className="form-intro">{canAdd?"Add someone who already has a workspace account.":"Remove members here. Adding members requires a workspace account."}</p>{canAdd&&<form onSubmit={add} className="member-form"><label className="sr-only" htmlFor="member-email">Member email</label><input id="member-email" type="email" required placeholder="teammate@company.com" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} /><button className="button primary" disabled={busy || !email.trim()}>Add member</button></form>}{(error || loadError) && <Notice error>{error || loadError}</Notice>}{notice && <Notice>{notice}</Notice>}{loading && !data && <p className="subtle">Loading members…</p>}<div className="member-list">{data?.members.map(member => <div className="member-row" key={member.id}><Avatar name={member.name} /><div><strong>{member.name}{member.id === currentUserId ? " (you)" : ""}</strong><span>{member.email}</span></div>{member.role === "owner" ? <span className="status-pill">Owner</span> : <button className="text-button danger" disabled={busy} onClick={() => remove(member)}>Remove</button>}</div>)}</div></Modal>;
}

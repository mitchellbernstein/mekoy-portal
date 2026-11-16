import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { AnimatePresence } from "motion/react";
import type { Bootstrap } from "../../shared/contracts";
import type { SharedMeetingNote, SharedMeetingNoteListItem } from "../../shared/meeting-notes";
import { api, ApiError, date, errorMessage, time, useApi, write } from "./api";
import { Avatar, Icon, Modal, Notice } from "./ui";
import "../team-notes.css";

export type SharedNotesData = { notes: SharedMeetingNoteListItem[]; nextCursor: string | null };

export function sharedNotesPath(scope: "feed" | "mine" | "team" | "folder", id?: string) {
  return `/api/meeting-notes?scope=${scope}${id ? `&id=${encodeURIComponent(id)}` : ""}`;
}

export function SharedNotesError({ error, reload }: { error: string; reload: () => void }) {
  const unsupported = /not found|404|not implemented|unsupported|unknown.*route/i.test(error);
  return <Notice error><span>{unsupported ? "Workspace notes are unavailable. Update the server if it does not support notes, or ask a workspace owner to check your access." : error}</span><button type="button" className="text-button" onClick={reload}>Try again</button></Notice>;
}

function NotePlacement({ note }: { note: Pick<SharedMeetingNote, "teamId" | "teamName" | "folderName"> }) {
  return <span className="shared-note-placement">{note.teamId && <Icon name="team" size={14}/>}<span>{note.teamId ? note.teamName || "Team" : "Private workspace copy"}</span>{note.folderName && <><span aria-hidden="true">·</span><Icon name="folder" size={13}/><span>{note.folderName}</span></>}</span>;
}

export function TeamNoteCard({ note }: { note: SharedMeetingNoteListItem }) {
  const target = `/notes/${encodeURIComponent(note.id)}`;
  return <article className="team-note-card feed-post" aria-labelledby={`shared-note-title-${note.id}`}>
    <header className="feed-post-header"><Avatar name={note.ownerName}/><div className="feed-post-author"><p><strong>{note.ownerName}</strong><span>{note.teamId ? "shared a meeting note" : "saved a private workspace copy"}</span></p><p><time dateTime={note.updatedAt}>{date(note.updatedAt)}</time><span className="meta-dot">·</span><NotePlacement note={note}/></p></div><Link className="feed-open" to={target} aria-label={`Open ${note.title}`}><Icon name="arrow" size={18}/></Link></header>
    <h2 id={`shared-note-title-${note.id}`} className="feed-post-title"><Link to={target}>{note.title}</Link></h2>
    {note.notesPreview.trim() ? <div className="team-note-preview"><span>Notes excerpt</span><p className="team-note-excerpt">{note.notesPreview}</p></div> : <p className="shared-note-empty">No handwritten notes in this shared copy.</p>}
    {note.summaryPreview && <div className="team-note-summary"><span>Existing summary excerpt · Derived content</span><p>{note.summaryPreview}</p></div>}
    <footer><span>{note.teamId ? "Published team copy" : "Private workspace copy"} · No audio included</span><Link className="text-button" to={target}>Read note<Icon name="arrow" size={14}/></Link></footer>
  </article>;
}

type Removal = { id: string; status: "confirm" | "removing" | "removed"; error: string };

export function SharedMeetingNotePage({ id, bootstrap, minePath = "/my-notes" }: { id: string; bootstrap: Bootstrap; minePath?: string }) {
  const { data, error, loading, reload } = useApi<{ note: SharedMeetingNote }>(`/api/meeting-notes/${encodeURIComponent(id)}`);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const location = useLocation();
  const content = useRef<HTMLDivElement>(null);
  const query = new URLSearchParams(location.search);
  const source = query.get("source");
  const segment = source === "transcript" ? query.get("segment") : null;
  const note = data?.note;
  const state = removal?.id === id ? removal : null;
  useEffect(() => {
    if (!note || !source) return;
    const target = source === "notes" ? content.current?.querySelector<HTMLElement>("#shared-note-notes") : [...content.current?.querySelectorAll<HTMLElement>(".shared-note-segment") || []].find(item => item.dataset.segmentId === segment);
    if (target) { target.scrollIntoView({ block: "center" }); target.focus({ preventScroll: true }); }
  }, [note, source, segment]);
  async function remove() {
    setRemoval({ id, status: "removing", error: "" });
    try { await write(`/api/meeting-notes/${encodeURIComponent(id)}`, "DELETE"); setRemoval({ id, status: "removed", error: "" }); }
    catch (failure) { setRemoval({ id, status: "confirm", error: errorMessage(failure) }); }
  }
  const removedPage = <div className="library-page shared-note-page"><header className="page-heading"><div><h1>{note?.teamId ? "Shared" : "Workspace"} copy removed</h1><p>Removing a workspace copy does not delete your private Mac note or any local audio.</p></div></header><Link className="button" to={minePath}>My notes</Link></div>;
  return <><AnimatePresence>{note && state && state.status !== "removed" && <Modal key={`remove:${id}`} title={note.teamId ? "Remove this shared copy?" : "Remove this workspace copy?"} busy={state.status === "removing"} onClose={() => setRemoval(null)}><p className="form-intro">This removes the saved workspace copy. It does not delete your private Mac note or any local audio.</p>{state.error && <Notice error>{state.error}</Notice>}<footer className="modal-footer"><button type="button" className="button" disabled={state.status === "removing"} onClick={() => setRemoval(null)}>Cancel</button><button type="button" className="button danger-button" disabled={state.status === "removing"} onClick={() => void remove()}>{state.status === "removing" ? "Removing…" : note.teamId ? "Remove shared copy" : "Remove workspace copy"}</button></footer></Modal>}{note && moveId === id && note.ownerId === bootstrap.user.id && <MoveNoteDialog key={`move:${id}`} note={note} bootstrap={bootstrap} onClose={() => setMoveId(null)} onMoved={() => { setMoveId(null); reload(); }} onReload={() => { setMoveId(null); reload(); }}/>}</AnimatePresence>{state?.status === "removed" ? removedPage : <div className="library-page shared-note-page">
    {error && <Notice error>{error}<button type="button" className="text-button" onClick={reload}>Try again</button></Notice>}
    {loading && !note && <div className="loading-state" role="status"><span className="spinner"/>Loading shared note…</div>}
    {note && <><header className="page-heading"><div><span className="eyebrow">Workspace meeting note</span><h1>{note.title}</h1><p>{note.ownerName} · <NotePlacement note={note}/> · Updated <time dateTime={note.updatedAt}>{date(note.updatedAt)}</time></p></div>{note.ownerId === bootstrap.user.id && <div className="shared-note-owner-actions"><button type="button" className="button" disabled={loading} onClick={() => setMoveId(id)}><Icon name="folder" size={15}/>Move note</button><button type="button" className="button" onClick={() => setRemoval({ id, status: "confirm", error: "" })}><Icon name="trash" size={15}/>{note.teamId ? "Remove shared copy" : "Remove workspace copy"}</button></div>}</header>
      <p className="shared-note-boundary">{note.teamId ? "This copy is shared with the selected team." : "This private workspace copy is visible only to your account."} Private Mac notes are not automatically synced, and audio is not included.</p>
      <div className="shared-note-content" ref={content}>
        <section id="shared-note-notes" className={source === "notes" ? "is-targeted" : ""} tabIndex={-1}><h2>Notes</h2>{note.notesText.trim() ? <p className="shared-note-text">{note.notesText}</p> : <p className="shared-note-empty">No handwritten notes in this shared copy.</p>}</section>
        <section><h2>Existing summary <span className="shared-note-derived">Derived content</span></h2>{note.summary ? <p className="shared-note-text">{note.summary}</p> : <p className="shared-note-empty">No summary was included in this shared copy.</p>}<p className="shared-note-caption">Generated summaries need review. Original notes and transcript remain separate sources.</p></section>
        <section><h2>Transcript</h2><p className="shared-note-caption">Timestamps identify the original recording. Audio is not included in this shared copy.</p>{note.transcript.length ? <div className="shared-note-transcript">{note.transcript.map(item => <article key={item.id} data-segment-id={item.id} className={`shared-note-segment${segment === item.id ? " is-targeted" : ""}`} tabIndex={-1}><header><span>{item.channel === "microphone" ? "Microphone" : "System audio"}</span><span>{time(item.startMs)}–{time(item.endMs)}</span></header><p>{item.text}</p></article>)}</div> : <p className="shared-note-empty">No transcript was included in this shared copy.</p>}</section>
      </div>
    </>}
  </div>}</>;
}

function MoveNoteDialog({ note, bootstrap, onClose, onMoved, onReload }: { note: SharedMeetingNote; bootstrap: Bootstrap; onClose: () => void; onMoved: () => void; onReload: () => void }) {
  const [teamId, setTeamId] = useState(note.teamId || "");
  const [folderId, setFolderId] = useState(note.folderId || "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; stale: boolean } | null>(null);
  const folders = bootstrap.folders.filter(folder => (folder.teamId || "") === teamId);
  const knownTeam = !teamId || bootstrap.teams.some(team => team.id === teamId);
  const knownFolder = !folderId || folders.some(folder => folder.id === folderId);
  const changed = teamId !== (note.teamId || "") || folderId !== (note.folderId || "");
  return <Modal title="Move note" busy={busy} onClose={onClose}><form className="stack-form" onSubmit={async event => {
    event.preventDefault();
    if (!changed || !knownTeam || !knownFolder || failure?.stale) return;
    setBusy(true); setFailure(null);
    try { await write(`/api/meeting-notes/${encodeURIComponent(note.id)}`, "PATCH", { teamId: teamId || null, folderId: folderId || null, expectedVersion: note.version }); onMoved(); }
    catch (error) { setFailure({ message: errorMessage(error), stale: error instanceof ApiError && error.status === 409 }); }
    finally { setBusy(false); }
  }}><p className="form-intro">Move only this workspace copy. Your private Mac note and any local audio are unchanged.</p><label>Visibility<select aria-label="Visibility" value={teamId} onChange={event => { setTeamId(event.target.value); setFolderId(""); }} disabled={busy}><option value="">Only me</option>{!knownTeam && <option value={teamId} disabled>{note.teamName || "Unavailable team"} · Current destination</option>}{bootstrap.teams.map(team => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label><p className="form-help">{teamId ? "Members of the selected team can read this copy." : "Only your account can read this workspace copy."}</p><label>Folder<select aria-label="Folder" value={folderId} onChange={event => setFolderId(event.target.value)} disabled={busy}><option value="">No folder</option>{!knownFolder && <option value={folderId} disabled>{note.folderName || "Unavailable folder"} · Current destination</option>}{folders.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label>{failure && <Notice error>{failure.message}{failure.stale && <button type="button" className="text-button" onClick={onReload}>Reload note</button>}</Notice>}<footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !changed || !knownTeam || !knownFolder || failure?.stale}>{busy ? "Moving…" : "Move note"}</button></footer></form></Modal>;
}

function useSharedNotesList(scope: "mine" | "team" | "folder", id?: string) {
  const path = sharedNotesPath(scope, id);
  const { data, error, loading, reload } = useApi<SharedNotesData>(path);
  const [continuation, setContinuation] = useState<{ base: SharedNotesData; notes: SharedMeetingNoteListItem[]; nextCursor: string | null; loading: boolean; error: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [data, path]);
  const current = continuation?.base === data ? continuation : null;
  const notes = current?.notes || data?.notes || [];
  const cursor = current ? current.nextCursor : data?.nextCursor;
  async function loadMore() {
    if (!data || !cursor || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setContinuation({ base: data, notes, nextCursor: cursor, loading: true, error: "" });
    try {
      const next = await api<SharedNotesData>(`${path}&cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal });
      if (!controller.signal.aborted) setContinuation({ base: data, notes: [...new Map([...notes, ...next.notes].map(note => [note.id, note])).values()], nextCursor: next.nextCursor, loading: false, error: "" });
    } catch (failure) {
      if (!controller.signal.aborted) setContinuation({ base: data, notes, nextCursor: cursor, loading: false, error: errorMessage(failure) });
    } finally { if (request.current === controller) request.current = null; }
  }
  return { data, notes, error, loading, reload, nextCursor: cursor, loadMore, loadingMore: !!current?.loading, moreError: current?.error };
}

export function SharedNotesCollection({ scope, id }: { scope: "team" | "folder"; id: string }) {
  const { data, notes, error, loading, reload, nextCursor, loadMore, loadingMore, moreError } = useSharedNotesList(scope, id);
  return <section className="collection-notes" aria-label="Written notes"><div className="section-heading"><h2>Written notes</h2>{data && <span>{notes.length} {nextCursor ? "shown" : notes.length === 1 ? "note" : "notes"}</span>}</div>
    {error && <SharedNotesError error={error} reload={reload}/>}
    {loading && !data && <p className="workspace-feed-loading" role="status">Loading written notes…</p>}
    {data && !notes.length && <p className="collection-empty-media">No written notes yet. Notes placed in this {scope} will appear here.</p>}
    {!!notes.length && <div className="collection-notes-grid">{notes.map(note => <TeamNoteCard note={note} key={note.id}/>)}</div>}
    {moreError && <Notice error>{moreError}</Notice>}{nextCursor && <button type="button" className="button shared-notes-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more notes"}</button>}
  </section>;
}

export function MySharedNotesPage({ bootstrap }: { bootstrap: Bootstrap }) {
  const { data, notes, error, loading, reload, nextCursor, loadMore, loadingMore, moreError } = useSharedNotesList("mine");
  const groups = new Map<string, SharedMeetingNoteListItem[]>();
  for (const note of [...notes].filter(note => note.ownerId === bootstrap.user.id).sort((a, b) => Date.parse(b.sourceCreatedAt) - Date.parse(a.sourceCreatedAt) || a.id.localeCompare(b.id))) {
    const day = date(note.sourceCreatedAt);
    groups.set(day, [...groups.get(day) || [], note]);
  }
  return <div className="library-page shared-notes-page"><header className="page-heading"><div><h1>My notes</h1><p>Copies you explicitly saved in your workspace. Private Mac notes are not automatically synced.</p></div></header>
    {error && <SharedNotesError error={error} reload={reload}/>}
    {loading && !data && <div className="loading-state" role="status"><span className="spinner"/>Loading your published notes…</div>}
    {data?.notes.length === 0 && <div className="empty-state"><h2>No workspace notes yet</h2><p>Open a private note in the Mac app and explicitly save a workspace copy.</p></div>}
    {[...groups].map(([day, notes]) => <section className="shared-notes-date-group" key={day} aria-label={day}><h2>{day}</h2><div>{notes.map(note => <Link className="shared-note-list-item" to={`/notes/${encodeURIComponent(note.id)}`} key={note.id}><span className="shared-note-file-icon"><Icon name="comment" size={18}/></span><span><strong>{note.title}</strong><small><NotePlacement note={note}/></small></span><time dateTime={note.sourceCreatedAt}>{new Date(note.sourceCreatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time><Icon name="arrow" size={15}/></Link>)}</div></section>)}
    {moreError && <Notice error>{moreError}</Notice>}
    {nextCursor && <button type="button" className="button shared-notes-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button>}
  </div>;
}

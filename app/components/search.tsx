import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Link, useNavigate } from "react-router";
import type { SearchHit } from "../../shared/contracts";
import type { MeetingListItem } from "../../shared/desktop-contracts";
import type { SharedMeetingNoteListItem } from "../../shared/meeting-notes";
import type { SearchAnswer, SearchResponse } from "../../shared/search-contracts";
import { api, ApiError, errorMessage, time, videoPath } from "./api";
import { Icon, Modal, Notice } from "./ui";
import "../search.css";

type SearchState = { status: "idle" } | { status: "loading"; query: string } | { status: "ready"; query: string; results: SearchHit[]; notes: SharedMeetingNoteListItem[]; warnings: string[] };
type AnswerState = { status: "idle" } | { status: "loading"; query: string } | { status: "ready"; query: string; answer: SearchAnswer } | { status: "error"; query: string; message: string };
const sources = { title: "Video title", comment: "Comment", speech: "Transcript", visual: "Visible in video" };
type LocalNote = Pick<MeetingListItem, "id" | "title" | "preview" | "updatedAt">;
type SearchResult = SearchHit | { noteId: string; title: string; text: string } | { workspaceNoteId: string; title: string; text: string };
type SearchAction = { kind: "open"; result: SearchResult } | { kind: "ask" };
type LocalSearch = { localNotes?: readonly LocalNote[]; workspaceConnected?: boolean; onConnectWorkspace?: () => void };
const resultPath = (hit: SearchResult) => "noteId" in hit ? `/meetings/${encodeURIComponent(hit.noteId)}` : "workspaceNoteId" in hit ? `/notes/${encodeURIComponent(hit.workspaceNoteId)}` : videoPath(hit.videoId, hit.positionMs);
const actionKey = (action: SearchAction) => action.kind === "ask" ? "ask" : resultPath(action.result);

export function useSearchShortcut(onOpen: () => void) {
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
      if ((apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && event.key.toLowerCase() === "k" && !event.repeat) {
        event.preventDefault();
        if (!document.querySelector("dialog[open]")) open.current();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
}

export function SearchDialog({ onClose, ...local }: { onClose: () => void } & LocalSearch) {
  const input = useRef<HTMLInputElement>(null);
  return <Modal title={local.workspaceConnected === false ? "Search notes" : "Search workspace"} className="search-dialog" initialFocus={input} onClose={onClose}><WorkspaceSearch input={input} onClose={onClose} {...local}/></Modal>;
}

export function SearchPage({ query }: { query: string }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="library-page workspace-search-page"><header className="page-heading"><div><h1>Search workspace</h1><p>Find a recording, a conversation, or the moment behind an answer.</p></div></header><WorkspaceSearch input={input} initialQuery={query} /></div>;
}

function WorkspaceSearch({ input, initialQuery = "", onClose, localNotes = [], workspaceConnected = true, onConnectWorkspace }: { input: RefObject<HTMLInputElement | null>; initialQuery?: string; onClose?: () => void } & LocalSearch) {
  const navigate = useNavigate();
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [answer, setAnswer] = useState<AnswerState>({ status: "idle" });
  const [selection, setSelection] = useState<string | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsId = useId();
  const answerRequest = useRef<AbortController | null>(null);
  const composing = useRef(false);
  const term = query.trim();
  const localResults = term ? localNotes.filter(note => `${note.title}\n${note.preview}`.toLocaleLowerCase().includes(term.toLocaleLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12).map(note => ({ noteId: note.id, title: note.title, text: note.preview })) : [];
  const currentSearch = search.status === "ready" && search.query === term ? search : null;
  const workspaceResults = currentSearch?.notes.map(note => ({ workspaceNoteId: note.id, title: note.title, text: note.notesPreview.trim() ? note.notesPreview : note.transcriptSegmentCount ? `${note.transcriptSegmentCount} transcript ${note.transcriptSegmentCount === 1 ? "segment" : "segments"}` : note.title })) || [];
  const results: SearchResult[] = [...localResults, ...workspaceResults, ...(currentSearch?.results || [])];
  const actions: SearchAction[] = [...results.map(result => ({ kind: "open" as const, result })), ...(workspaceConnected && term ? [{ kind: "ask" as const }] : [])];
  const exactTitle = results.findIndex(result => ("videoTitle" in result ? result.videoTitle : result.title).trim().replace(/\s+/g, " ").toLocaleLowerCase() === term.replace(/\s+/g, " ").toLocaleLowerCase());
  const question = currentSearch && /\?$|^(?:what|which|why|who|when|where|how|can|could|would|should|did|does|do|is|are|was|were|have|has|summari[sz]e|explain|compare|describe|recap|tell me|give me|list)\b/i.test(currentSearch.query);
  const defaultSelection = exactTitle >= 0 ? exactTitle : workspaceConnected && question ? results.length : results.length ? 0 : -1;
  const selectedAction = actions.findIndex(action => actionKey(action) === selection);
  const active = selectedAction >= 0 ? selectedAction : defaultSelection;
  const activeAction = actions[active];
  const currentAnswer = answer.status !== "idle" && answer.query === term ? answer : null;

  useEffect(() => {
    if (!term) { setSearch({ status: "idle" }); return; }
    if (!workspaceConnected) { setSearch({ status: "ready", query: term, results: [], notes: [], warnings: [] }); return; }
    const controller = new AbortController();
    setSearch({ status: "loading", query: term });
    const timer = window.setTimeout(() => {
      void Promise.allSettled([
        api<SearchResponse>(`/api/search?q=${encodeURIComponent(term)}`, { signal: controller.signal }),
        api<{ notes: SharedMeetingNoteListItem[] }>(`/api/meeting-notes?scope=feed&q=${encodeURIComponent(term)}`, { signal: controller.signal }),
      ]).then(([videos, notes]) => {
        if (controller.signal.aborted) return;
        const warnings: string[] = [];
        if (videos.status === "rejected") warnings.push(`Video search could not finish. ${errorMessage(videos.reason)}`);
        if (notes.status === "rejected") warnings.push(notes.reason instanceof ApiError && notes.reason.status === 404 ? "Workspace note search is unavailable on this server. Update the workspace server to search shared notes." : `Workspace note search could not finish. ${errorMessage(notes.reason)}`);
        const noteItems = notes.status === "fulfilled" ? notes.value?.notes || [] : [];
        setSearch({ status: "ready", query: term, results: videos.status === "fulfilled" ? videos.value.results : [], notes: noteItems, warnings });
      });
    }, 160);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [term, revision, workspaceConnected]);

  useEffect(() => () => answerRequest.current?.abort(), []);
  useEffect(() => { resultsRef.current?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest" }); }, [active, search]);
  useEffect(() => { if (pendingSubmit === term && currentSearch) { setPendingSubmit(null); submit(); } }, [pendingSubmit, currentSearch, active]);

  function cancelAnswer() { answerRequest.current?.abort(); answerRequest.current = null; setAnswer({ status: "idle" }); setPendingSubmit(null); }
  function changeQuery(value: string) { cancelAnswer(); setSelection(null); setQuery(value); }
  function select(hit: SearchResult) { onClose?.(); navigate(resultPath(hit)); }
  function submit() {
    if (!term || composing.current) return;
    if (!currentSearch && workspaceConnected && selection === null) { setPendingSubmit(term); return; }
    if (activeAction?.kind === "ask") void ask();
    else if (activeAction) select(activeAction.result);
  }
  async function ask() {
    if (!term || !workspaceConnected || composing.current || currentAnswer?.status === "loading") return;
    setPendingSubmit(null);
    answerRequest.current?.abort();
    const controller = new AbortController(); answerRequest.current = controller;
    setAnswer({ status: "loading", query: term });
    try {
      const result = await api<SearchAnswer>("/api/search/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: term }), signal: controller.signal });
      if (!controller.signal.aborted && answerRequest.current === controller) setAnswer({ status: "ready", query: term, answer: result });
    } catch (error) {
      if (!controller.signal.aborted && answerRequest.current === controller) {
        setAnswer({ status: "error", query: term, message: errorMessage(error) });
        if (error instanceof ApiError && [401, 403, 409].includes(error.status)) { setSearch({ status: "loading", query: term }); setRevision(value => value + 1); }
      }
    }
  }

  return <div className={`workspace-search${onClose ? "" : " search-page-content"}`} onKeyDownCapture={event => {
    if (event.key === "Escape" && onClose) {
      event.preventDefault(); event.stopPropagation();
      if (!event.nativeEvent.isComposing && !composing.current) { cancelAnswer(); onClose(); }
    }
  }}>
    <form className="command-search" role="search" onSubmit={event => { event.preventDefault(); submit(); }}>
      <Icon name={activeAction?.kind === "ask" ? "sparkle" : "search"} size={21} />
      <input ref={input} type="search" role="combobox" aria-label="Search notes, videos, comments, or transcripts" aria-autocomplete="list" aria-expanded={actions.length > 0} aria-controls={actions.length ? resultsId : undefined} aria-activedescendant={activeAction ? `${resultsId}-${active}` : undefined} placeholder={workspaceConnected ? "Search or ask your workspace…" : "Search notes on this Mac…"} autoComplete="off" spellCheck={false} maxLength={300} value={query} onChange={event => changeQuery(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing.current) { if (event.key === "Enter") event.preventDefault(); return; }
        if (event.key === "Enter") { event.preventDefault(); submit(); }
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && actions.length) {
          event.preventDefault(); setSelection(actionKey(actions[(active + (event.key === "ArrowDown" ? 1 : -1) + actions.length) % actions.length]));
        }
      }} />
    </form>
    {!workspaceConnected && <p className="search-connect-hint">Search saved note titles and previews here. Connect your workspace to search videos.{onConnectWorkspace && <button type="button" className="text-button" onClick={onConnectWorkspace}>Connect workspace</button>}</p>}
    <div className="command-search-body">
      {!term ? <div className="command-search-empty"><span className="search-empty-icon"><Icon name="search" size={23} /></span><h3>{workspaceConnected ? "Find the moment you're looking for" : "Find a note on this Mac"}</h3><p>{workspaceConnected ? "A title, a phrase, or a question. Start anywhere." : "Search a saved note title or a phrase from its preview."}</p></div> : <>
        {currentAnswer && <section className="command-answer" aria-label="Workspace answer" aria-live="polite">
          {currentAnswer.status === "loading" && <div className="answer-loading" role="status"><span className="spinner" /><div><strong>Finding supporting moments</strong><p>Building an answer from video evidence.</p></div><button type="button" className="text-button" onClick={cancelAnswer}>Cancel</button></div>}
          {currentAnswer?.status === "error" && <Notice error>{currentAnswer.message}<button className="text-button" type="button" onClick={() => void ask()}>Try again</button></Notice>}
          {currentAnswer?.status === "ready" && <Answer answer={currentAnswer.answer} onClose={onClose} />}
        </section>}
        {currentSearch?.warnings.map(warning => <Notice error key={warning}>{warning}<button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>Try again</button></Notice>)}
        {!currentSearch && workspaceConnected && <div className="command-search-status" role="status"><span className="spinner" />Searching your workspace…</div>}
        {!results.length && currentSearch && !currentSearch.warnings.length && <div className="command-search-empty" role="status"><h3>{workspaceConnected ? "No matching moments" : "No matching notes"}</h3><p>{workspaceConnected ? "Try a title or a phrase from a recording, or ask a question below." : "Try a title or a phrase from your saved notes."}</p></div>}
        {!!actions.length && <>
          {!!results.length && <p className="command-result-count" role="status">{results.length} {results.length === 1 ? "result" : "results"}</p>}
          <div className="command-results" ref={resultsRef} id={resultsId} role="listbox" aria-label="Search results">{results.map((result, index) => <Link id={`${resultsId}-${index}`} role="option" aria-selected={active === index} tabIndex={-1} className="command-result" to={resultPath(result)} key={`${resultPath(result)}-${index}`} onMouseMove={() => setSelection(resultPath(result))} onClick={onClose}>
            <span className="command-result-icon"><Icon name={"noteId" in result || "workspaceNoteId" in result ? "edit" : result.source === "comment" ? "comment" : "video"} size={18} /></span><span className="command-result-copy"><span className="command-result-source">{"noteId" in result ? "My notes" : "workspaceNoteId" in result ? "Workspace note" : sources[result.source]}{"positionMs" in result && result.positionMs !== null && <span>{time(result.positionMs)}</span>}</span><strong>{"noteId" in result || "workspaceNoteId" in result ? result.title : result.videoTitle}</strong><span className="command-result-text">{result.text}</span></span><Icon name="arrow" size={15} />
          </Link>)}{workspaceConnected && <button id={`${resultsId}-${results.length}`} type="button" className="command-ask-option" role="option" aria-label="Ask workspace" aria-describedby={`${resultsId}-coverage`} aria-selected={active === results.length} tabIndex={-1} disabled={currentAnswer?.status === "loading"} onMouseMove={() => setSelection("ask")} onClick={() => void ask()}><Icon name="sparkle" size={18} /><span><strong>Ask workspace</strong><span id={`${resultsId}-coverage`}>Answers from videos. Notes are not included.</span></span><Icon name="arrow" size={15} /></button>}</div>
        </>}
      </>}
    </div>
    <footer className="command-search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd>{activeAction?.kind === "ask" ? "to ask" : "to open"}</span>{onClose && <span><kbd>esc</kbd> to close</span>}</footer>
  </div>;
}

function Answer({ answer, onClose }: { answer: SearchAnswer; onClose?: () => void }) {
  if (answer.status === "insufficient_evidence") return <div className="answer-insufficient" role="status"><Icon name="search" size={19} /><div><strong>Not enough evidence yet</strong><p>{answer.message}</p>{answer.retrievalWarning && <p className="answer-warning">{answer.retrievalWarning}</p>}</div></div>;
  return <div className="answer-content"><header><Icon name="sparkle" size={16} /><h3>Answer from your workspace</h3><span>AI</span></header>{answer.statements.map((statement, index) => <div className="answer-statement" key={index}><p>{statement.text}</p><div className="answer-citations">{statement.citations.map((citation, citationIndex) => <Link className="answer-citation" to={videoPath(citation.videoId, citation.positionMs)} onClick={onClose} key={`${citation.videoId}-${citation.positionMs}-${citationIndex}`}><span className="answer-citation-heading"><Icon name={citation.source === "comment" ? "comment" : "video"} size={14} /><strong>{citation.videoTitle}</strong>{citation.positionMs !== null && <span>{time(citation.positionMs)}</span>}<Icon name="arrow" size={13} /></span><span className="answer-citation-quote">{citation.quote}</span><span className="answer-citation-source">{sources[citation.source]}</span></Link>)}</div></div>)}{answer.retrievalWarning && <p className="answer-warning">{answer.retrievalWarning}</p>}</div>;
}

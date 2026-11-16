import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, NavLink, useLocation, useNavigate, useSearchParams } from "react-router";
import type { Bootstrap, Folder, Team } from "../../shared/contracts";
import type { MeetingListItem } from "../../shared/desktop-contracts";
import { errorMessage, videoPath, write, type ApiSeed } from "./api";
import { LibraryPage, type LibraryData, type LibraryScope } from "./library";
import { SearchDialog, SearchPage, useSearchShortcut } from "./search";
import { NotificationsMenu } from "./activity";
import { UploadDialog } from "./upload";
import { VideoPage } from "./video";
import { MySharedNotesPage, SharedMeetingNotePage } from "./team-notes";
import { agentNames, AgentsPage } from "./agents";
import { Avatar, Icon, Modal, Notice } from "./ui";
import { MacSetup } from "./mac-setup";
import { ShellFrame } from "./shell-frame";
import { Popover } from "./popover";
import type { ShellHistory, WorkspaceSidebarOverride } from "./window-chrome";
import "../shell-polish.css";
import "../sidebar-motion.css";
import "../navigation.css";

export function libraryScope(pathname: string): { scope: LibraryScope; id?: string } | null {
  const [page, id] = pathname.split("/").filter(Boolean);
  const scope = !page ? "home" : page === "my-videos" ? "mine" : page === "teams" && id ? "team" : page === "folders" && id ? "folder" : null;
  return scope ? { scope, id } : null;
}

export type WorkspaceShellProps = {
  bootstrap: Bootstrap; serverOrigin: string; library?: ApiSeed<LibraryData> | null;
  desktop?: {
    navigation: (actions: { onUpload: () => void }) => ReactNode; footer: ReactNode; history?: ShellHistory; sidebar?: WorkspaceSidebarOverride; onSignOut: () => Promise<void>;
    localNotes?: MeetingListItem[]; onConnectWorkspace?: () => void;
    page?: { title: string; content: ReactNode; actions?: ReactNode };
  };
};

export function WorkspaceShell({ bootstrap, serverOrigin, library, desktop }: WorkspaceShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [notice, setNotice] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [create, setCreate] = useState<"team" | "folder" | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [applePlatform, setApplePlatform] = useState(false);
  const [videoTitleTarget, setVideoTitleTarget] = useState<HTMLSpanElement | null>(null);
  const [videoToolbarTarget, setVideoToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [videoPanelTarget, setVideoPanelTarget] = useState<HTMLDivElement | null>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const segments = location.pathname.split("/").filter(Boolean);
  const [page, id] = segments;
  const scope = libraryScope(location.pathname)?.scope || "home";
  const team = bootstrap?.teams.find(item => item.id === id);
  const folder = bootstrap?.folders.find(item => item.id === id);
  const isVideo = page === "videos" && !!id;
  const isNote = page === "notes" && !!id && segments.length === 2;
  const isMyNotes = page === "my-notes" && segments.length === 1;
  const isSearch = page === "search";
  const isAgents = page === "agents";
  const agent = id === "feedback" ? "feedback" : "demo";
  const knownPage = !page || isVideo || isNote || isMyNotes || isSearch || isAgents && (!id || id === "demo" || id === "feedback") && segments.length <= 2 || page === "my-videos" || (page === "teams" || page === "folders") && !!id;
  useSearchShortcut(() => setSearchOpen(true));

  useEffect(() => { setNotice(""); }, [location]);
  useEffect(() => { scrollContainer.current?.scrollTo(0, 0); }, [location.pathname]);
  useEffect(() => {
    const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    setApplePlatform(apple);
  }, []);

  async function signOut() {
    try { if (desktop) await desktop.onSignOut(); else { await write("/api/auth/sign-out", "POST"); window.location.assign("/"); } }
    catch (error) { setNotice(errorMessage(error)); }
  }

  const sidebar = <>
        <div className="sidebar-identity"><Link className="wordmark" to={desktop ? "/home" : "/"}><span className="brand-mark"><Icon name="video" size={19} /></span><span>Video workspace</span></Link><NotificationsMenu connected/><button type="button" className="icon-button" aria-label="Search" title={applePlatform ? "Search (⌘K)" : "Search (Ctrl+K)"} onClick={() => setSearchOpen(true)} aria-haspopup="dialog" aria-keyshortcuts={applePlatform ? "Meta+K" : "Control+K"}><Icon name="search" size={17}/></button></div>
        <nav>{desktop ? desktop.navigation({ onUpload: () => setUploadOpen(true) }) : <div className="primary-nav"><NavLink to="/" end><Icon name="home"/>Home</NavLink><NavLink to="/my-videos"><Icon name="video"/>My videos</NavLink><NavLink to="/my-notes"><Icon name="edit"/>My notes</NavLink></div>}
          <AgentNavigation/>
          {(bootstrap.account.canOrganize||bootstrap.teams.length>0)&&<NavSection title="Teams" onCreate={bootstrap.account.canOrganize?() => setCreate("team"):undefined}>
            {bootstrap.teams.map(item => <NavLink to={`/teams/${encodeURIComponent(item.id)}`} key={item.id} title={item.name}><Icon name="team" /><span className="nav-item-label">{item.name}</span></NavLink>)}
            {bootstrap.account.canOrganize&&!bootstrap.teams.length && <button className="nav-empty" onClick={() => setCreate("team")}>Create your first team</button>}
          </NavSection>}
          {bootstrap.account.canOrganize&&<NavSection title="Folders" onCreate={() => setCreate("folder")}>
            {bootstrap.folders.map(item => <NavLink to={`/folders/${encodeURIComponent(item.id)}`} key={item.id} title={item.name}><Icon name="folder" /><span className="nav-item-label">{item.name}</span></NavLink>)}
            {!bootstrap.folders.length && <button className="nav-empty" onClick={() => setCreate("folder")}>Create a folder</button>}
          </NavSection>}
        </nav>
        <div className="sidebar-bottom">{desktop?.footer}{!desktop && <button className="button sidebar-upload" onClick={() => setUploadOpen(true)}><Icon name="plus" size={17} />Upload video</button>}<AccountMenu bootstrap={bootstrap} onSignOut={signOut} onSettings={desktop?.onConnectWorkspace}/></div>
  </>;
  return (
    <>
    <ShellFrame desktop={!!desktop} history={desktop?.history} scrollRef={scrollContainer} sidebar={desktop?.sidebar || { label: "Workspace navigation", content: sidebar }}>
        <header className={`topbar${isVideo && !desktop?.page ? " video-topbar" : ""}`}>
          <div className="topbar-main">
          <nav className="breadcrumbs" aria-label="Breadcrumb">{desktop?.page ? <span className="current" aria-current="page">{desktop.page.title}</span> : <><Link to={desktop ? "/home" : "/"}>Home</Link>{!!page && <><span aria-hidden="true">/</span>{isVideo ? <><Link to="/my-videos">My videos</Link><span aria-hidden="true">/</span><span ref={setVideoTitleTarget} className="current video-breadcrumb" aria-current="page" /></> : <>{isAgents&&<><Link to="/agents/demo">Agents</Link><span aria-hidden="true">/</span></>}<span className="current" aria-current="page">{isNote ? "Note" : isMyNotes ? "My notes" : isSearch ? "Search" : isAgents ? agentNames[agent] : scope === "mine" ? "My videos" : team?.name || folder?.name || "Workspace"}</span></>}</>}</>}</nav><div ref={setVideoToolbarTarget} className="topbar-actions">{desktop?.page?.actions}</div>
          </div>
          {isVideo && !desktop?.page && <div ref={setVideoPanelTarget} className="panel-toolbar" />}
        </header>
        {notice && <div className="shell-notice"><Notice error>{notice}</Notice></div>}
        <main id="main-content" tabIndex={-1}>
          {!desktop && !page && <MacSetup user={bootstrap.user} serverOrigin={serverOrigin} onUpload={() => setUploadOpen(true)} />}
          {desktop?.page ? desktop.page.content : !knownPage ? <div className="standalone-state"><h1>This page isn’t here</h1><Link className="button primary" to={desktop ? "/home" : "/"}>Go to Home</Link></div> : isNote ? <SharedMeetingNotePage key={id} id={id} bootstrap={bootstrap} minePath={desktop ? "/meetings" : "/my-notes"}/> : isMyNotes ? <MySharedNotesPage bootstrap={bootstrap}/> : isVideo ? <VideoPage key={id} id={id} bootstrap={bootstrap} titleTarget={videoTitleTarget} toolbarTarget={videoToolbarTarget} panelTarget={videoPanelTarget} /> : isAgents ? !id ? <Navigate to="/agents/demo" replace/> : <AgentsPage key={agent} agent={agent} bootstrap={bootstrap}/> : isSearch ? <SearchPage key={params.get("q")} query={params.get("q") || ""} /> : <LibraryPage key={`${scope}-${id || ""}`} bootstrap={bootstrap} scope={scope} id={id} initialData={library} onUpload={() => setUploadOpen(true)} />}
        </main>
    </ShellFrame>
    <AnimatePresence>
      {searchOpen && <SearchDialog key="search" onClose={() => setSearchOpen(false)} localNotes={desktop?.localNotes} onConnectWorkspace={desktop?.onConnectWorkspace}/>}
      {uploadOpen && <UploadDialog key="upload" bootstrap={bootstrap} initialTeamId={scope === "team" && !isVideo ? id : undefined} initialFolderId={scope === "folder" ? id : undefined} onClose={() => setUploadOpen(false)} onComplete={videoId => { setUploadOpen(false); navigate(videoPath(videoId)); }} />}
      {create && bootstrap.account.canOrganize && <CreateDialog key={create} kind={create} bootstrap={bootstrap} initialTeamId={scope === "team" ? id : undefined} onClose={() => setCreate(null)} onTeam={item => { setCreate(null); navigate(`/teams/${encodeURIComponent(item.id)}`); }} onFolder={item => { setCreate(null); navigate(`/folders/${encodeURIComponent(item.id)}`); }} />}
    </AnimatePresence>
    </>
  );
}

function AccountMenu({ bootstrap, onSignOut, onSettings }: { bootstrap: Bootstrap; onSignOut(): Promise<void>; onSettings?: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return <div className="account-menu"><button type="button" ref={anchor} className="account-trigger" aria-label="Account menu" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}><Avatar name={bootstrap.user.name}/><span><strong>{bootstrap.user.name}</strong><small>{bootstrap.user.email}</small></span><Icon name="chevron" size={16}/></button><Popover open={open} anchor={anchor} label="Account" className="account-popover" onClose={() => setOpen(false)}><span>{bootstrap.account.plan === "free" ? "Free account" : "Workspace account"}</span><span>Signed in as {bootstrap.user.email}</span>{!bootstrap.account.canOrganize && <span>To create teams or organize recordings, ask the server owner to enable a workspace account.</span>}{onSettings && <button type="button" onClick={() => { setOpen(false); onSettings(); }}>Settings</button>}<button type="button" onClick={() => { setOpen(false); void onSignOut(); }}>Sign out</button></Popover></div>;
}

export function AgentNavigation() {
  return <NavSection title="Agents"><NavLink to="/agents/demo"><Icon name="sparkle"/><span className="nav-item-label">Demos</span></NavLink><NavLink to="/agents/feedback"><Icon name="comment"/><span className="nav-item-label">Feedback</span></NavLink></NavSection>;
}

function NavSection({ title, children, onCreate }: { title: string; children: ReactNode; onCreate?: () => void }) {
  const [open, setOpen] = useState(true);
  return <section className="nav-section"><div className="nav-section-heading"><button className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><span>{title}</span><Icon name="chevron" size={16} className={open ? "" : "is-collapsed"} /></button>{onCreate&&<button className="icon-button" aria-label={`Create ${title === "Teams" ? "team" : "folder"}`} onClick={onCreate}><Icon name="plus" size={16} /></button>}</div>{open && <div className="nav-section-links">{children}</div>}</section>;
}

function CreateDialog({ kind, bootstrap, initialTeamId, onClose, onTeam, onFolder }: { kind: "team" | "folder"; bootstrap: Bootstrap; initialTeamId?: string; onClose: () => void; onTeam: (team: Team) => void; onFolder: (folder: Folder) => void }) {
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState(initialTeamId || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (kind === "team") { const result = await write<{ team: Team }>("/api/teams", "POST", { name: name.trim() }); onTeam(result.team); }
      else { const result = await write<{ folder: Folder }>("/api/folders", "POST", { name: name.trim(), teamId: teamId || null }); onFolder(result.folder); }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title={`Create a ${kind}`} onClose={onClose} busy={busy}><form onSubmit={submit} className="stack-form"><p className="form-intro">{kind === "team" ? "A place to share recordings and ideas with your people." : "Keep related recordings together."}</p><label>{kind === "team" ? "Team name" : "Folder name"}<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder={kind === "team" ? "e.g. Design team" : "e.g. Product walkthroughs"} disabled={busy} /></label>{kind === "folder" && <label>Location<select value={teamId} onChange={event => setTeamId(event.target.value)} disabled={busy}><option value="">My videos</option>{bootstrap.teams.map(team => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label>}{error && <Notice error>{error}</Notice>}<footer className="modal-footer"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : `Create ${kind}`}</button></footer></form></Modal>;
}

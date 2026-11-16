import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence } from "motion/react";
import type { AgentAudience, AgentRun, AgentSchedule, AgentWorkspace, Bootstrap, FeedbackReview } from "../../shared/contracts";
import { agentTemplateIds, agentTemplates } from "../../shared/agent-templates";
import type { AgentTemplate, VoiceSetup } from "../../shared/agent-templates";
import { date, errorMessage, time, useApi, videoPath, workspaceOrigin, write } from "./api";
import { CardPreview } from "./card-preview";
import { Empty, Icon, Modal, Notice } from "./ui";
import { PersonalVoice } from "./agent-voice";
import "../agent-workspaces.css";

export const agentNames = { demo: "Demo agent", feedback: "Feedback agent" };
type AgentKind = keyof typeof agentNames;
type AgentPageProps = { bootstrap: Bootstrap; agent: AgentKind };
type WorkspaceProps = { bootstrap: Bootstrap; data: AgentWorkspace; reload: () => void };
type SettingsView = "overview" | "connect" | AgentAudience;
type SettingsAction = Exclude<SettingsView, "overview"> | `disconnect:${string}`;
const activeReviews = new Set(["pending", "running", "retry", "uncertain"]);
const runLabels: Record<string, string> = { pending: "Queued", preparing: "Preparing", ready: "Waiting for recorder", running: "Recording", uploaded: "Saved", failed: "Failed", empty: "No changes" };
const reviewLabels: Record<string, string> = { pending: "Queued", running: "Reviewing", retry: "Retry scheduled", uncertain: "Checking outcome", succeeded: "Reviewed", blocked: "Needs attention", error: "Failed" };

export function AgentsPage({ bootstrap, agent }: AgentPageProps) {
  return <AgentWorkspacePage key={bootstrap.user.id} bootstrap={bootstrap} agent={agent}/>;
}

function AgentWorkspacePage({ bootstrap, agent }: AgentPageProps) {
  const { data, error, reload } = useApi<AgentWorkspace>("/api/agents");
  const [lastWorkspace, setLastWorkspace] = useState<AgentWorkspace | null>(null);
  useEffect(() => { if (data) setLastWorkspace(data); }, [data]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") reload(); }, 15000);
    return () => window.clearInterval(timer);
  }, [reload]);
  const workspace = data ?? lastWorkspace;
  if (!workspace) return <div className="library-page agent-page"><h1>{agentNames[agent]}</h1>{error ? <Notice error>{error}<button className="text-button" onClick={reload}>Try again</button></Notice> : <div className="loading-state" role="status"><span className="spinner" />Loading agent work…</div>}</div>;
  return <>{error&&<div className="shell-notice"><Notice error>Could not refresh agent work. {error}<button className="text-button" onClick={reload}>Try again</button></Notice></div>}{agent === "demo" ? <DemoPage bootstrap={bootstrap} data={workspace} reload={reload}/> : <FeedbackPage bootstrap={bootstrap} data={workspace} reload={reload}/>}</>;
}

function AgentHeader({ agent, children }: { agent: AgentKind; children: ReactNode }) {
  return <header className="page-heading agent-heading"><div className="agent-identity"><span className={`agent-avatar ${agent}`}><Icon name={agent === "demo" ? "sparkle" : "comment"} size={25}/></span><div><h1>{agentNames[agent]}</h1><p>{agent === "demo" ? "Turn your team’s latest work into videos worth sharing." : "A fresh perspective on the work in your videos."}</p></div></div><div className="heading-actions">{children}</div></header>;
}

function DemoPage({ bootstrap, data, reload }: WorkspaceProps) {
  const [teamId, setTeamId] = useState(bootstrap.teams[0]?.id || "");
  const [dialog, setDialog] = useState<"settings" | "run" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const team = bootstrap.teams.find(item => item.id === teamId);
  const owner = team?.role === "owner";
  const canAutomate = owner && bootstrap.account.canOrganize;
  const runs = data.runs.filter(item => item.teamId === teamId);
  const outputs = runs.filter(run => run.status === "uploaded" && run.videoId);
  const activity = runs.filter(run => run.status !== "uploaded" || !run.videoId);
  const connections = data.connections.filter(item => item.teamId === teamId && item.status === "connected");
  const next = data.schedules.filter(item => item.teamId === teamId && item.enabled).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0];
  async function retry(id: string) {
    setBusy(true); setError("");
    try { await write(`/api/agents/runs/${encodeURIComponent(id)}/retry`, "POST"); reload(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <div className="library-page agent-page">
    <AgentHeader agent="demo"><button className="button agent-settings-trigger" onClick={() => setDialog("settings")}>Settings</button>{canAutomate&&<button className="button primary" onClick={() => setDialog("run")}><Icon name="plus" size={16}/>Create update</button>}</AgentHeader>
    {error&&<Notice error>{error}</Notice>}
    {team&&<div className="agent-context"><label><Icon name="team" size={16}/><span className="sr-only">Agent team</span><select aria-label="Agent team" value={teamId} disabled={busy} onChange={event => { setTeamId(event.target.value); setDialog(null); setError(""); }}>{bootstrap.teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span>{next ? `Next update ${new Date(next.nextRunAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: next.timeZone })} · ${next.timeZone}` : `${connections.length} ${connections.length === 1 ? "repository" : "repositories"} connected`}</span></div>}
    <section className="agent-output-section" aria-labelledby="demo-output-heading"><div className="section-heading"><h2 id="demo-output-heading">Latest videos</h2>{outputs.length>0&&<span>{outputs.length} {outputs.length===1?"video":"videos"}</span>}</div>
      {outputs.length ? <div className="agent-output-grid">{outputs.map(run => <DemoOutput key={run.id} run={run} accountKey={`${workspaceOrigin()}/${bootstrap.user.id}`}/>)}</div> : <Empty title={team ? "Your next update starts here" : bootstrap.account.canOrganize ? "Give your team a Demo agent" : "Demo automation needs a workspace account"} action={canAutomate ? <button className="button" onClick={() => setDialog(connections.length ? "run" : "settings")}>{connections.length ? "Create your first update" : "Connect a repository"}<Icon name="arrow" size={16}/></button> : undefined}>{!bootstrap.account.canOrganize ? "Ask the server owner to enable a workspace account for new demo automation. Existing videos stay available, and team owners can manage cleanup in Settings." : !team ? "Create a team from the sidebar to turn its work into narrated demos." : connections.length ? "Create a narrated roundup of recent changes. Finished videos will be collected here." : owner ? "Connect your team’s GitHub repository in Settings. New work becomes a narrated demo, with the finished video saved here." : "Your team’s finished demos and updates will appear here. A team owner can connect a repository and create the first update."}</Empty>}
    </section>
    <section className="agent-activity" aria-labelledby="demo-activity-heading"><div className="section-heading"><h2 id="demo-activity-heading">Activity</h2><button className="text-button" disabled={busy} onClick={reload}>Refresh</button></div>{activity.length ? <div className="agent-activity-list">{activity.map(run => <article className="agent-run" key={run.id}><span className={`agent-run-dot ${run.status}`} aria-hidden="true"/><div className="agent-run-copy"><div><h3>{run.title}</h3><span className="agent-status">{runLabels[run.status] || run.status}</span></div><p>{run.audience === "customer" ? "Customer draft" : "Internal team video"} · {date(run.createdAt)}</p>{run.error&&<p className="provider-error">{run.error}</p>}{run.status === "empty"&&<p>No eligible changes were found for this week.</p>}{run.status === "uploaded"&&!run.videoId&&<p>The saved video is private or no longer available.</p>}</div>{canAutomate&&["failed", "empty"].includes(run.status)&&<button className="button" disabled={busy} onClick={() => retry(run.id)}>Retry run</button>}</article>)}</div> : <p className="agent-quiet">New demos, scheduled updates, and runs that need attention will appear here.</p>}</section>
    <AnimatePresence>{dialog === "settings"&&<DemoSettings key={`settings:${teamId}`} teamId={teamId} owner={owner} canOrganize={bootstrap.account.canOrganize} data={data} onClose={() => setDialog(null)} reload={reload}/>}
    {dialog === "run"&&canAutomate&&<RunNow key={`run:${teamId}`} teamId={teamId} onSettings={()=>setDialog("settings")} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); reload(); }}/>}</AnimatePresence>

  </div>;
}

function DemoOutput({ run, accountKey }: { run: AgentRun; accountKey: string }) {
  const link = useRef<HTMLAnchorElement>(null);
  const partial = run.result?.status === "partial";
  return <article className="agent-output"><Link ref={link} className="agent-output-link" to={videoPath(run.videoId!)}><div className="agent-video-preview"><CardPreview videoId={run.videoId!} accountKey={accountKey} link={link}/><span className="agent-preview-play"><Icon name="play" size={22}/></span><span className="agent-preview-label">{run.presentation?agentTemplates[run.presentation.template].label:run.kind === "weekly" || run.kind === "manual" ? "Weekly update" : "Demo"}</span></div><div className="agent-output-copy"><p className="agent-output-kind">{run.audience === "customer" ? "Customer draft" : "Team video"}{partial&&<span className="agent-review-label">Some demos need review</span>}</p><h3>{run.title}</h3><p>{date(run.createdAt)}<span aria-hidden="true">·</span>{run.audience === "customer" ? "Review before sharing" : "Ready to watch"}</p>{run.presentation?.narration.kind==="personal"&&<p>AI narration with {run.presentation.narration.name}'s consented voice</p>}{run.error&&<p className="provider-error">{run.error}</p>}</div></Link>{run.audience === "customer"&&<footer><a download href={`/api/videos/${encodeURIComponent(run.videoId!)}/media`}>Download draft<Icon name="upload" size={13}/></a></footer>}</article>;
}

function FeedbackPage({ bootstrap, data, reload }: WorkspaceProps) {
  const [dialog, setDialog] = useState<"settings" | "review" | null>(null);
  const reviews = data.feedback.filter(item => item.status !== null || item.comments.length > 0);
  return <div className="library-page agent-page">
    <AgentHeader agent="feedback"><button className="button agent-settings-trigger" onClick={() => setDialog("settings")}>Settings</button><button className="button primary" onClick={() => setDialog("review")}><Icon name="plus" size={16}/>Request review</button></AgentHeader>
    <div className="agent-context agent-perspectives"><span><Icon name="comment" size={16}/>Engineering, Design, and Product</span><span>Grounded in your transcript and video frames</span></div>
    {!data.setup.ai&&<div className="agent-setup-note"><span>Video reviews need AI setup.</span><button className="text-button" onClick={() => setDialog("settings")}>Open Settings<Icon name="arrow" size={14}/></button></div>}
    <section aria-labelledby="feedback-heading"><div className="section-heading"><h2 id="feedback-heading">Recent reviews</h2><button className="text-button" onClick={reload}>Refresh</button></div>{reviews.length ? <div className="agent-reviews">{reviews.map(review => <FeedbackOutput key={review.video.id} review={review} canRetry={review.video.ownerId === bootstrap.user.id} reload={reload}/>)}</div> : <Empty title="Another set of eyes on your work" action={<button className="button" onClick={() => setDialog("review")}>Choose a video<Icon name="arrow" size={16}/></button>}>Request a review of your recording. Feedback appears at the exact video moments, from Engineering, Design, and Product.</Empty>}</section>
    <AnimatePresence>{dialog === "settings"&&<Modal key="feedback-settings" title="Feedback agent settings" className="agent-settings" onClose={() => setDialog(null)}><p className="agent-drawer-intro">Reviews use the complete transcript and sampled frames. Every observation links back to a moment in your video.</p><ProviderSetup data={data} feedback/><section className="agent-settings-section"><h3>Transcription</h3><p>{bootstrap.capabilities.transcription}</p><p>Finish transcription before requesting a review. Silent videos also need a completed transcript.</p></section><section className="agent-settings-section"><h3>Who can request a review?</h3><p>Video owners can request and retry reviews. Feedback follows the video’s sharing settings, so only people who can watch can read it.</p></section></Modal>}
    {dialog === "review"&&<RequestReview key={`review:${bootstrap.user.id}`} reviews={data.feedback} ownerId={bootstrap.user.id} aiReady={data.setup.ai} onSettings={() => setDialog("settings")} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); reload(); }}/>}</AnimatePresence>
  </div>;
}

function FeedbackOutput({ review, canRetry, reload }: { review: FeedbackReview; canRetry: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function retry() {
    setBusy(true); setError("");
    try { await write(`/api/videos/${encodeURIComponent(review.video.id)}/feedback`, "POST"); reload(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <article className="agent-review"><header><Link className="agent-review-video" to={videoPath(review.video.id)}><span className="agent-review-video-icon"><Icon name="video" size={20}/></span><span><h3>{review.video.title}</h3><span>{review.video.ownerName} · {date(review.updatedAt || review.video.createdAt)}</span></span></Link><span className={`agent-status ${review.status === "succeeded" ? "complete" : ""}`}>{review.status ? reviewLabels[review.status] || review.status : "Feedback available"}</span></header>{review.comments.length > 0&&<div className="agent-review-comments">{review.comments.map(comment => <Link className="agent-feedback-moment" to={videoPath(review.video.id, comment.positionMs)} key={comment.id}><div><strong>{comment.authorName.replace("Feedback agent · ", "")}</strong><span>{time(comment.positionMs)}<Icon name="arrow" size={13}/></span></div><p>{comment.body.split("\n\n")[0]}</p></Link>)}</div>}{review.status === "succeeded"&&!review.comments.length&&<p className="agent-review-message">Review completed. No visible feedback comments remain.</p>}{activeReviews.has(review.status || "")&&<p className="agent-review-message">{review.status === "running" ? "Reading the transcript and sampled video frames." : review.status === "retry" ? "The review will retry automatically. Your video remains available." : "Your review request is saved. Feedback will appear here when the job finishes."}</p>}{review.error&&<details className="agent-review-details"><summary>Details</summary><p className="provider-error">{review.error}</p></details>}{error&&<p className="provider-error" role="alert">{error}</p>}{canRetry&&["blocked", "error"].includes(review.status || "")&&<button className="button" disabled={busy} onClick={retry}>{busy ? "Requesting…" : "Retry review"}</button>}</article>;
}

function RequestReview({ reviews, ownerId, aiReady, onSettings, onClose, onSaved }: { reviews: FeedbackReview[]; ownerId: string; aiReady: boolean; onSettings: () => void; onClose: () => void; onSaved: () => void }) {
  const eligible = reviews.filter(item => item.video.ownerId === ownerId && item.transcriptionComplete && !activeReviews.has(item.status || "") && item.status !== "succeeded" && !item.comments.length);
  const [videoId, setVideoId] = useState(eligible[0]?.video.id || "");
  const selectedVideoId = eligible.some(item => item.video.id === videoId) ? videoId : eligible[0]?.video.id || "";
  useEffect(() => { setVideoId(selectedVideoId); }, [selectedVideoId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!selectedVideoId) { setError("Choose a video that is ready for review."); return; }
    setBusy(true);
    try { await write(`/api/videos/${encodeURIComponent(selectedVideoId)}/feedback`, "POST"); onSaved(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title="Request a video review" onClose={onClose} busy={busy} className="agent-form-dialog"><form className="stack-form" onSubmit={submit}><p className="form-intro">Get timestamped feedback from Engineering, Design, and Product. Your video keeps its current sharing settings.</p>{eligible.length ? <label>Video<select value={selectedVideoId} onChange={event => setVideoId(event.target.value)} disabled={busy}>{eligible.map(item => <option key={item.video.id} value={item.video.id}>{item.video.title}</option>)}</select></label> : <div className="agent-form-empty"><h3>No videos ready for review</h3><p>Choose one of your uploaded videos after transcription finishes. Active and completed reviews are already in Recent reviews.</p><Link className="text-button" to="/my-videos" onClick={onClose}>Go to My videos<Icon name="arrow" size={15}/></Link></div>}{!aiReady&&<Notice>AI setup is needed before reviews can finish.<button className="text-button" type="button" disabled={busy} onClick={onSettings}>Open Settings</button></Notice>}{error&&<Notice error>{error}</Notice>}<footer className="modal-footer"><button className="button" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !selectedVideoId}>{busy ? "Requesting…" : "Request review"}</button></footer></form></Modal>;
}

function ProviderSetup({ data, feedback = false }: { data: AgentWorkspace; feedback?: boolean }) {
  return <section className="agent-settings-section"><h3>{feedback ? "Video review setup" : "Recording setup"}</h3>{!feedback&&<div className="agent-provider"><span className={`agent-connection-dot ${data.setup.runner ? "connected" : ""}`}/><div><strong>Demo recorder</strong><p>{data.setup.runner ? "Runner token configured. The recorder service must be running to claim queued demos." : "Ask your workspace operator to configure DEMO_RUNNER_TOKEN and run the demo recorder service."}</p></div></div>}<div className="agent-provider"><span className={`agent-connection-dot ${data.setup.ai ? "connected" : ""}`}/><div><strong>Workers AI</strong><p>{data.setup.ai ? "Credentials configured for AI planning and video reviews." : "Ask your workspace operator to set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to enable AI planning and video feedback."}</p></div></div>{!feedback&&<p>Checked-in demo recipes can record without AI planning.</p>}</section>;
}

function DemoSettings({ teamId, owner, canOrganize, data, onClose, reload }: { teamId: string; owner: boolean; canOrganize:boolean; data: AgentWorkspace; onClose: () => void; reload: () => void }) {
  const [view, setView] = useState<SettingsView>("overview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const disconnectCancel = useRef<HTMLButtonElement>(null);
  const actions = useRef<Partial<Record<SettingsAction, HTMLButtonElement | null>>>({});
  const returnAction = useRef<SettingsAction | null>(null);
  const connections = data.connections.filter(item => item.teamId === teamId);
  useEffect(() => { if (view !== "overview") heading.current?.focus(); }, [view]);
  useEffect(() => { if (disconnectId && !busy) disconnectCancel.current?.focus(); }, [disconnectId, busy]);
  useEffect(() => {
    if (view !== "overview" || disconnectId || busy || !returnAction.current) return;
    (actions.current[returnAction.current] || actions.current.connect)?.focus();
    returnAction.current = null;
  }, [view, disconnectId, busy]);
  function openView(next: Exclude<SettingsView, "overview">) { returnAction.current = next; setView(next); }
  function cancelDisconnect(id: string) { returnAction.current = `disconnect:${id}`; setDisconnectId(null); }
  async function disconnect(id: string) {
    setBusy(true); setError("");
    try { const result = await write<{ warning?: string }>(`/api/agents/connections/${encodeURIComponent(id)}`, "DELETE"); returnAction.current = "connect"; setDisconnectId(null); if (result.warning) setError(result.warning); reload(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  function saved() { setView("overview"); reload(); }
  async function pause(audience:AgentAudience) {
    setBusy(true);setError("");
    try {await write("/api/agents/schedules","POST",{teamId,audience,enabled:false});reload();}
    catch(failure) {setError(errorMessage(failure));}
    finally {setBusy(false);}
  }
  return <Modal title="Demo agent settings" className="agent-settings" onClose={onClose} busy={busy}>
    {view === "overview" ? <><p className="agent-drawer-intro">Choose the source work and when your team gets an update.</p>{error&&<Notice error>{error}</Notice>}
      <section className="agent-settings-section"><div className="section-heading"><h3>Repositories</h3>{owner&&canOrganize&&<button ref={node => { actions.current.connect = node; }} className="text-button" onClick={() => openView("connect")} disabled={busy}>Connect GitHub<Icon name="plus" size={14}/></button>}</div>{!connections.length ? <p>{teamId ? "No repositories connected yet." : canOrganize ? "Create a team from the sidebar to connect a repository." : "Ask the server owner to enable a workspace account for new demo automation."}</p> : <div className="agent-connections">{connections.map(connection => <div className="agent-connection" key={connection.id}><div className="agent-connection-heading"><Icon name="folder" size={17}/><div><strong>{connection.repository}</strong><span>{connection.branch} · {connection.status}</span></div>{owner&&connection.status !== "disconnected"&&disconnectId !== connection.id&&<button ref={node => { actions.current[`disconnect:${connection.id}`] = node; }} className="text-button danger" disabled={busy} onClick={() => setDisconnectId(connection.id)}>Disconnect</button>}</div>{connection.error&&<p className="provider-error">{connection.error}</p>}{disconnectId === connection.id&&<div className="agent-disconnect-confirm" role="group" aria-labelledby={`disconnect-${connection.id}`}><p id={`disconnect-${connection.id}`}>Stop future demos from {connection.repository}? Saved videos will stay.</p><div><button ref={disconnectCancel} aria-describedby={`disconnect-${connection.id}`} className="button" disabled={busy} onClick={() => cancelDisconnect(connection.id)}>Cancel</button><button className="button danger" disabled={busy} onClick={() => disconnect(connection.id)}>{busy ? "Disconnecting…" : "Disconnect repository"}</button></div></div>}</div>)}</div>}</section>
      <section className="agent-settings-section"><h3>Weekly updates</h3><div className="agent-schedules">{(["internal", "customer"] as const).map(kind => { const schedule = data.schedules.find(item => item.teamId === teamId && item.audience === kind); return <div className="agent-schedule" key={kind}><div><strong>{kind === "internal" ? "Team roundup" : "Customer release update"}</strong><p>{kind === "internal" ? "Released work and clearly labeled work in progress." : "Published releases only. A private draft to review before sharing."}</p><span>{schedule ? `${schedule.enabled ? "Next" : "Paused"} · ${new Date(schedule.nextRunAt).toLocaleString(undefined, { timeZone: schedule.timeZone })} · ${schedule.timeZone}` : "No schedule yet"}</span></div>{owner&&(canOrganize?<button ref={node => { actions.current[kind] = node; }} className="button" disabled={busy} onClick={() => openView(kind)}>{schedule ? "Edit schedule" : "Schedule"}</button>:schedule?.enabled&&<button className="button" disabled={busy} onClick={()=>void pause(kind)}>Pause schedule</button>)}</div>; })}</div></section>
      {owner&&!canOrganize&&<p className="agent-owner-note">You can disconnect repositories and pause existing schedules. Ask the server owner to enable a workspace account for new automation.</p>}{!owner&&teamId&&<p className="agent-owner-note">A team owner can connect repositories and change schedules.</p>}<PersonalVoice busy={busy} setBusy={setBusy}/><ProviderSetup data={data}/>
    </> : <><button className="text-button agent-settings-back" disabled={busy} onClick={() => setView("overview")}><Icon name="arrow" size={15}/>Back to Settings</button><h3 ref={heading} tabIndex={-1} className="agent-form-title">{view === "connect" ? "Connect a codebase" : view === "internal" ? "Weekly team roundup" : "Weekly customer update"}</h3>{view === "connect" ? <ConnectRepository key={teamId} teamId={teamId} busy={busy} setBusy={setBusy} onSaved={saved}/> : <ScheduleUpdate key={`${teamId}-${view}`} teamId={teamId} audience={view} existing={data.schedules.find(item => item.teamId === teamId && item.audience === view)} busy={busy} setBusy={setBusy} onSaved={saved}/>}</>}
  </Modal>;
}

type SettingsFormProps = { teamId: string; busy: boolean; setBusy: (busy: boolean) => void; onSaved: () => void };
function ConnectRepository({ teamId, busy, setBusy, onSaved }: SettingsFormProps) {
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget);
    try { await write("/api/agents/connections", "POST", { teamId, repository: String(form.get("repository")).trim(), token: String(form.get("token")), branch: String(form.get("branch")).trim() }); onSaved(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <form className="stack-form" onSubmit={submit}><label>GitHub repository<input name="repository" required placeholder="your-team/your-app" pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" disabled={busy} spellCheck={false}/></label><label>Branch<input name="branch" required defaultValue="main" disabled={busy} spellCheck={false}/></label><label>Fine-grained GitHub token<input name="token" type="password" autoComplete="off" required disabled={busy}/></label><p className="form-intro">Use a repository admin’s token with Contents and Pull requests read access and Webhooks write access. The token stays encrypted on your server.</p><p className="form-intro">Add <code>.video-workspace/demo.json</code> to the repository with its startup command, port, and demo goal. The recorder runs the app in isolated containers.</p>{error&&<Notice error>{error}</Notice>}<button className="button primary" disabled={busy}>{busy ? "Connecting…" : "Connect GitHub"}</button></form>;
}

function RunNow({ teamId, onClose, onSaved, onSettings }: { teamId: string; onClose: () => void; onSaved: () => void; onSettings:()=>void }) {
  const [kind, setKind] = useState<AgentAudience>("internal");
  const [template,setTemplate]=useState<AgentTemplate>("weekly_team");
  const [narration,setNarration]=useState("default");
  const [requestId]=useState(()=>crypto.randomUUID());
  const {data:voice,error:voiceError}=useApi<VoiceSetup>("/api/agents/voice");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form=new FormData(event.currentTarget);
    try { await write("/api/agents/run", "POST", { teamId, audience: kind, requestId,template,recipient:String(form.get("recipient")||""),brief:String(form.get("brief")||""),narration }); onSaved(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title="Create a narrated video" onClose={onClose} busy={busy} className="agent-form-dialog"><form className="stack-form" onSubmit={submit}>
    <label>Purpose<select value={template} disabled={busy} onChange={event=>{const next=event.target.value as AgentTemplate;setTemplate(next);if(next==="customer_release") setKind("customer");if(next==="weekly_team") setKind("internal");}}>{agentTemplateIds.map(id=><option key={id} value={id}>{agentTemplates[id].label}</option>)}</select></label><p className="form-intro">{agentTemplates[template].description}</p>
    <label>Audience<select value={kind} onChange={event => {const next=event.target.value==="customer"?"customer":"internal";setKind(next);if(template==="weekly_team"||template==="customer_release") setTemplate(next==="customer"?"customer_release":"weekly_team");}} disabled={busy}><option value="internal">Internal team</option><option value="customer">Customer release draft</option></select></label>
    <label>Who is this for?<input name="recipient" maxLength={120} placeholder="For example, Taylor on Product" disabled={busy}/></label><p className="form-intro">This personalizes the recording. Sharing and access stay under your control.</p>
    <label>Source context and goal<textarea name="brief" maxLength={3000} required={agentTemplates[template].requiresBrief} placeholder={agentTemplates[template].briefHint} rows={4} disabled={busy}/></label><p className="form-intro">{agentTemplates[template].briefHint} Supplied context is labeled in narration. The recorder uses approved connected app snapshots from the past seven days.</p>
    <label>Narration<select value={narration} disabled={busy} onChange={event=>setNarration(event.target.value)}><option value="default">Default synthetic voice</option><option value="personal" disabled={!voice?.configured||voice.profile?.status!=="ready"}>{voice?.profile?`My voice · ${voice.profile.name}`:"My voice · setup needed"}</option></select></label>
    {(!voice?.configured||voice.profile?.status!=="ready")&&<p className="form-intro">{voiceError||"Set up and verify your own voice to use personal narration."}<button type="button" className="text-button" disabled={busy} onClick={onSettings}>Open voice settings</button></p>}
    {kind==="customer"&&<p className="form-intro">Only published releases enter this private draft. Review it before sharing with customers.</p>}
    {error&&<Notice error>{error}</Notice>}<footer className="modal-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Queueing…" : "Create narrated video"}</button></footer>
  </form></Modal>;
}

function ScheduleUpdate({ teamId, audience, existing, busy, setBusy, onSaved }: SettingsFormProps & { audience: AgentAudience; existing?: AgentSchedule }) {
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget); const [hour, minute] = String(form.get("time")).split(":").map(Number);
    try { await write("/api/agents/schedules", "POST", { teamId, audience, weekday: Number(form.get("weekday")), minute: hour * 60 + minute, timeZone: String(form.get("zone")).trim(), enabled: form.has("enabled") }); onSaved(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  const minute = existing?.minute ?? 540;
  return <form className="stack-form" onSubmit={submit}><label>Day<select name="weekday" defaultValue={existing?.weekday ?? 0} disabled={busy}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label><label>Time<input name="time" type="time" required defaultValue={`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`} disabled={busy}/></label><label>Timezone<input name="zone" required defaultValue={existing?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone} disabled={busy} spellCheck={false}/></label><label className="agent-checkbox"><input name="enabled" type="checkbox" defaultChecked={existing?.enabled ?? true} disabled={busy}/>Create a video every week</label>{audience === "customer"&&<p className="form-intro">Customer updates remain private drafts. No messages are sent to customers.</p>}{error&&<Notice error>{error}</Notice>}<button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save schedule"}</button></form>;
}

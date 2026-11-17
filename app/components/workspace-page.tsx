import { useState } from "react";
import { Link, useLoaderData, useLocation, useRevalidator, type ClientLoaderFunctionArgs, type MetaArgs } from "react-router";
import type { PageData } from "../../shared/contracts";
import { api, errorMessage, write, type ApiSeed } from "./api";
import { libraryPath, type LibraryData } from "./library";
import { AuthPage } from "./auth";
import { WorkspaceShell, libraryScope } from "./workspace-shell";
import { Notice } from "./ui";
import type { loader } from "../server/workspace-loader.server";

export type { PageData } from "../../shared/contracts";
export function meta({ loaderData: pageData }: MetaArgs<typeof loader>) {
  const title = pageData?.kind === "auth" ? `${pageData.mode === "signup" ? "Create account" : "Sign in"} · Video workspace` : "Video workspace";
  const description = "Record your screen, share a video, and keep the conversation at the right moment.";
  return [{ title }, { name: "description", content: description }];
}

export async function clientLoader({ request, url, serverLoader }: ClientLoaderFunctionArgs): Promise<PageData> {
  const page = await serverLoader<typeof loader>();
  if (page.kind !== "workspace") return page;
  const target = libraryScope(url.pathname);
  if (!target) return page;
  const path = libraryPath(target.scope, target.id);
  let library: ApiSeed<LibraryData>;
  try { library = { path, data: await api<LibraryData>(path, { signal: request.signal }), error: "" }; }
  catch (error) {
    if (request.signal.aborted) throw error;
    library = { path, data: null, error: errorMessage(error) };
  }
  return { ...page, library };
}

export default function Workspace() {
  const pageData = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const location = useLocation();
  if (pageData.kind === "auth") return <AuthPage key={pageData.mode} mode={pageData.mode} onAuthenticated={() => revalidator.revalidate()} />;
  if (location.pathname === "/join") return <JoinTeam email={pageData.bootstrap.user.email} token={location.hash.slice(1)} />;
  return <WorkspaceShell key={pageData.bootstrap.user.id} {...pageData} />;
}

function JoinTeam({ email, token }: { email: string; token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = /^[A-Za-z0-9_-]{43}$/.test(token);
  async function accept() {
    setBusy(true); setError("");
    try { const result = await write<{ team: { id: string } }>("/api/team-invitations/accept", "POST", { token }); window.location.assign(`/teams/${encodeURIComponent(result.team.id)}`); }
    catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  }
  async function switchAccount() {
    setBusy(true); setError("");
    try { await write("/api/auth/sign-out", "POST"); window.location.reload(); }
    catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  }
  return <main className="standalone-state"><h1>Join team</h1><p>Signed in as {email}. Accept only a link shared with you directly by the team owner.</p>{!valid && <Notice error>Invitation link missing or invalid. Ask the owner for a new link.</Notice>}{error && <Notice error>{error}</Notice>}<button className="button primary" disabled={busy || !valid} onClick={accept}>{busy ? "Opening invitation…" : "Accept invitation"}</button><button className="text-button" disabled={busy} onClick={switchAccount}>Use another account</button><Link to="/">Go to Home</Link></main>;
}

export function ErrorBoundary() {
  return <main className="standalone-state"><h1>Your workspace couldn’t load</h1><p>We couldn’t reach your workspace. Try again to reload this page.</p><button className="button primary" onClick={() => window.location.reload()}>Try again</button><Link to="/">Go to Home</Link></main>;
}

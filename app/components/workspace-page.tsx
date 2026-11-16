import { Link, useLoaderData, useRevalidator, type ClientLoaderFunctionArgs, type MetaArgs } from "react-router";
import type { PageData } from "../../shared/contracts";
import { api, errorMessage, type ApiSeed } from "./api";
import { libraryPath, type LibraryData } from "./library";
import { AuthPage } from "./auth";
import { WorkspaceShell, libraryScope } from "./workspace-shell";
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
  if (pageData.kind === "auth") return <AuthPage key={pageData.mode} mode={pageData.mode} onAuthenticated={() => revalidator.revalidate()} />;
  return <WorkspaceShell key={pageData.bootstrap.user.id} {...pageData} />;
}

export function ErrorBoundary() {
  return <main className="standalone-state"><h1>Your workspace couldn’t load</h1><p>We couldn’t reach your workspace. Try again to reload this page.</p><button className="button primary" onClick={() => window.location.reload()}>Try again</button><Link to="/">Go to Home</Link></main>;
}

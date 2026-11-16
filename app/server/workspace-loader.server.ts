import { data, redirect, type LoaderFunctionArgs } from "react-router";
import type { Bootstrap, PageData } from "../../shared/contracts";
import { runtimeContext } from "../runtime-context";
import { loadBootstrap } from "./bootstrap";
import { currentUser, HttpError, origin } from "./runtime";

const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function loader({ request, context, url }: LoaderFunctionArgs) {
  const runtime = context.get(runtimeContext);
  const pathname = url.pathname;
  let user: Bootstrap["user"];
  try { user = await currentUser(request, runtime); }
  catch (error) {
    if (!(error instanceof HttpError && error.status === 401)) throw error;
    return data<PageData>({ kind: "auth", mode: pathname === "/signup" ? "signup" : "signin" }, { headers: privateHeaders });
  }
  if (pathname === "/signup" || pathname === "/signin") throw redirect("/", { headers: privateHeaders });
  return data<PageData>({ kind: "workspace", bootstrap: await loadBootstrap(runtime, user), serverOrigin: origin(runtime) }, { headers: privateHeaders });
}

export function headers() { return privateHeaders; }

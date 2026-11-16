import type { Bootstrap, Folder, Team, User } from "../../shared/contracts";
import type { Runtime } from "./runtime";
import { accountEntitlements } from "./entitlements";
import { transcriptionProvider, transcriptionSetup } from "./transcription";

export async function loadBootstrap(runtime: Runtime, user: User): Promise<Bootstrap> {
  const teams = await runtime.db.query<Team>("SELECT t.id,t.name,m.role FROM teams t JOIN memberships m ON m.team_id=t.id WHERE m.user_id=$1 ORDER BY t.name", [user.id]);
  const folders = await runtime.db.query<Folder>("SELECT f.id,f.name,f.team_id AS \"teamId\" FROM folders f WHERE (f.team_id IS NULL AND f.owner_id=$1) OR EXISTS(SELECT 1 FROM memberships m WHERE m.team_id=f.team_id AND m.user_id=$1) ORDER BY f.name", [user.id]);
  const env = runtime.env;
  const transcription = transcriptionProvider(runtime);
  return { user, account: await accountEntitlements(runtime.db, user.id), teams: teams.rows, folders: folders.rows, capabilities: { storage: runtime.storage.kind,
    ai: env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID ? "Workers AI configured" : "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for summaries, embeddings and visual text",
    transcription: transcription ? `${transcription} configured` : transcriptionSetup,
    slack: env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET ? "Connect Slack from a team" : "Slack needs server setup. Ask the workspace owner to configure it" } };
}

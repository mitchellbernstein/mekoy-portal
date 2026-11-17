import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { User } from "../../shared/contracts";
import { member } from "./domain";
import { requireOrganization } from "./entitlements";
import { body, json } from "./http";
import { HttpError, origin, transaction, type Runtime, type Sql } from "./runtime";

const emailInput = z.object({ email: z.email() }).strict();
const tokenInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const purpose = (ownerId: string) => `member-invite:${ownerId}`;

async function ownedTeam(db: Sql, teamId: string, userId: string) {
  const team = (await db.query("SELECT id,name,owner_id FROM teams WHERE id=$1 AND owner_id=$2 FOR UPDATE", [teamId, userId])).rows[0];
  if (!team) throw new HttpError(404, "Team not found");
  await member(db, teamId, userId, true);
  return team;
}

export async function teamMembershipApi(request: Request, runtime: Runtime, user: User): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === "/api/team-invitations/accept" && method === "POST") {
    const input = await body(request, tokenInput);
    const team = await transaction(runtime.db, async db => {
      const pending = (await db.query("SELECT team_id FROM oauth_states WHERE token_hash=$1 AND user_id=$2 AND purpose LIKE 'member-invite:%' AND expires_at>now()", [hash(input.token), user.id])).rows[0];
      if (!pending) throw new HttpError(400, "Invitation unavailable. Ask the owner for a new link for this account");
      const team = (await db.query("SELECT id,name,owner_id FROM teams WHERE id=$1 FOR UPDATE", [pending.team_id])).rows[0];
      if (!team) throw new HttpError(400, "Invitation unavailable");
      await member(db, team.id, team.owner_id, true);
      await requireOrganization(db, team.owner_id, team.id);
      await requireOrganization(db, user.id);
      const consumed = await db.query("DELETE FROM oauth_states WHERE token_hash=$1 AND user_id=$2 AND team_id=$3 AND purpose=$4 AND expires_at>now() RETURNING team_id", [hash(input.token), user.id, team.id, purpose(team.owner_id)]);
      if (!consumed.rowCount) throw new HttpError(400, "Invitation unavailable. Ask the owner for a new link for this account");
      await db.query("INSERT INTO memberships(team_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING", [team.id, user.id]);
      return { id: team.id, name: team.name, role: "member" };
    });
    return json({ team });
  }
  const match = /^\/api\/teams\/([^/]+)\/(members|invitations)(?:\/([^/]+))?$/.exec(path);
  if (!match) return null;
  const [, teamId, resource, memberId] = match;
  if (resource === "members" && method === "GET" && !memberId) {
    await ownedTeam(runtime.db, teamId, user.id);
    const rows = await runtime.db.query('SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE m.team_id=$1 ORDER BY u.name', [teamId]);
    return json({ members: rows.rows });
  }
  if (method === "POST" && !memberId) {
    const input = await body(request, emailInput);
    return json(await transaction(runtime.db, async db => {
      await ownedTeam(db, teamId, user.id);
      await requireOrganization(db, user.id, teamId);
      const recipient = (await db.query('SELECT id,email,"emailVerified" FROM "user" WHERE lower(email)=lower($1)', [input.email])).rows[0];
      if (!recipient) throw new HttpError(404, "That person needs to create an account first");
      await requireOrganization(db, recipient.id);
      if (resource === "members") {
        if (!recipient.emailVerified) throw new HttpError(409, "This email is unverified. Create an invitation link and share it directly with the intended person");
        await db.query("INSERT INTO memberships(team_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING", [teamId, recipient.id]);
        return { added: true };
      }
      if ((await db.query("SELECT 1 FROM memberships WHERE team_id=$1 AND user_id=$2", [teamId, recipient.id])).rowCount) throw new HttpError(409, "That account is already a member");
      const token = randomBytes(32).toString("base64url");
      await db.query("DELETE FROM oauth_states WHERE team_id=$1 AND user_id=$2 AND purpose LIKE 'member-invite:%'", [teamId, recipient.id]);
      const pending = (await db.query("INSERT INTO oauth_states(token_hash,user_id,team_id,expires_at,purpose) VALUES($1,$2,$3,now()+interval '24 hours',$4) RETURNING expires_at", [hash(token), recipient.id, teamId, purpose(user.id)])).rows[0];
      return { invitation: { email: recipient.email, url: `${origin(runtime)}/join#${token}`, expiresAt: new Date(pending.expires_at).toISOString() } };
    }));
  }
  if (method === "DELETE" && resource === "invitations" && !memberId) {
    const input = await body(request, tokenInput);
    return json(await transaction(runtime.db, async db => {
      await ownedTeam(db, teamId, user.id);
      const revoked = await db.query("DELETE FROM oauth_states WHERE token_hash=$1 AND team_id=$2 AND purpose=$3", [hash(input.token), teamId, purpose(user.id)]);
      return { revoked: !!revoked.rowCount };
    }));
  }
  if (method === "DELETE" && resource === "members" && memberId) {
    return json(await transaction(runtime.db, async db => {
      await ownedTeam(db, teamId, user.id);
      const removed = await db.query("DELETE FROM memberships WHERE team_id=$1 AND user_id=$2 AND role<>'owner' RETURNING user_id", [teamId, memberId]);
      if (!removed.rowCount) throw new HttpError(400, "Team owner cannot be removed");
      await db.query("DELETE FROM oauth_states WHERE team_id=$1 AND user_id=$2 AND purpose LIKE 'member-invite:%'", [teamId, memberId]);
      return { removed: true };
    }));
  }
  throw new HttpError(405, "Method not allowed");
}

import type { AccountEntitlements, AccountPlan } from "../../shared/contracts";
import { HttpError } from "./runtime";
import type { Sql } from "./runtime";

export async function accountEntitlements(db:Sql,userId:string):Promise<AccountEntitlements> {
  const row=(await db.query('SELECT "workspacePlan" FROM "user" WHERE id=$1',[userId])).rows[0];
  if(!row) throw new HttpError(401,"Sign in to continue");
  const plan:AccountPlan=row.workspacePlan;
  if(plan!=="free"&&plan!=="workspace") throw new HttpError(503,"Ask the server owner to repair this account's plan");
  return {plan,canOrganize:plan==="workspace"};
}

export async function requireOrganization(db:Sql,userId:string,teamId?:string|null) {
  if(!(await accountEntitlements(db,userId)).canOrganize) throw new HttpError(403,"Video organization requires a workspace account. Ask the server owner to enable it");
  if(teamId) {
    const row=(await db.query('SELECT u."workspacePlan" FROM teams t JOIN "user" u ON u.id=t.owner_id JOIN memberships m ON m.team_id=t.id AND m.user_id=$2 WHERE t.id=$1',[teamId,userId])).rows[0];
    if(!row) throw new HttpError(404,"Team not found");
    if(row.workspacePlan!=="workspace") throw new HttpError(403,"This team's owner needs a workspace account before adding organization content");
  }
}

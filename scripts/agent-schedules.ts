import { sweepAgentSchedules } from "../app/server/agents";
import { createPool } from "../app/server/runtime";
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
const db=createPool(process.env.DATABASE_URL);
try {console.log(await sweepAgentSchedules({db}));}
finally {await db.end();}

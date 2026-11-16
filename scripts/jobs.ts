import path from "node:path";
import { createAuth, createPool } from "../app/server/runtime";
import { runJobs } from "../app/server/jobs";
import { LocalMedia } from "../server/local-media";
if(!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
const db=createPool(process.env.DATABASE_URL);
try {console.log(await runJobs({db,auth:createAuth(db,process.env),env:process.env,storage:new LocalMedia(path.resolve(process.env.MEDIA_ROOT||".local/media"))},Number(process.env.JOB_LIMIT||10)));}
finally {await db.end();}

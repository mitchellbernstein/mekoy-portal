import { readFile, writeFile, rename, rm } from "node:fs/promises";
const required=["APP_ORIGIN","CLOUDFLARE_ACCOUNT_ID","CLOUDFLARE_CONFIG_API_TOKEN","HYPERDRIVE_ID","R2_BUCKET_NAME","CLOUDFLARE_QUEUE_NAME"];
const defaultPlan=process.env.DEFAULT_ACCOUNT_PLAN||"workspace";
if(defaultPlan!=="free"&&defaultPlan!=="workspace") throw new Error("Set DEFAULT_ACCOUNT_PLAN to free or workspace");
for(const name of required) if(!process.env[name]) throw new Error(`Set ${name} to the existing resource before configuring Cloudflare`);
let appOrigin:URL;
try {appOrigin=new URL(process.env.APP_ORIGIN!);} catch {throw new Error("Set APP_ORIGIN to the app's public HTTPS origin");}
if(appOrigin.protocol!=="https:"||appOrigin.origin!==process.env.APP_ORIGIN!.replace(/\/$/,"")) throw new Error("APP_ORIGIN must be a public HTTPS origin without credentials, a path, query or fragment");
if(!/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID!)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be the actual 32-character account ID");
if(!/^[a-f0-9]{32}$/i.test(process.env.HYPERDRIVE_ID!)) throw new Error("HYPERDRIVE_ID must be the actual 32-character resource ID");
const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/hyperdrive/configs/${process.env.HYPERDRIVE_ID}`,{headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_CONFIG_API_TOKEN}`},signal:AbortSignal.timeout(20_000)});
const resource=await response.json() as {success?:boolean;result?:{caching?:{disabled?:boolean}}};
if(!response.ok||!resource.success) throw new Error("Cannot verify Hyperdrive. Give this token permission to read the selected configuration");
if(resource.result?.caching?.disabled!==true) throw new Error("Disable query caching on the selected Hyperdrive before configuring the app. Membership authorization requires fresh reads");
const config=JSON.parse(await readFile("wrangler.jsonc","utf8"));
config.name=process.env.CLOUDFLARE_WORKER_NAME||"video-workspace";
config.account_id=process.env.CLOUDFLARE_ACCOUNT_ID;
config.hyperdrive=[{binding:"HYPERDRIVE",id:process.env.HYPERDRIVE_ID}];
config.r2_buckets=[{binding:"ORIGINALS",bucket_name:process.env.R2_BUCKET_NAME}];
config.ai={binding:"AI"};
config.queues={producers:[{binding:"JOBS",queue:process.env.CLOUDFLARE_QUEUE_NAME}],consumers:[{queue:process.env.CLOUDFLARE_QUEUE_NAME,max_batch_size:1,max_concurrency:1,max_retries:3}]};
config.vars={APP_ORIGIN:appOrigin.origin,BETTER_AUTH_URL:appOrigin.origin,DEFAULT_ACCOUNT_PLAN:defaultPlan,CLOUDFLARE_ACCOUNT_ID:process.env.CLOUDFLARE_ACCOUNT_ID,R2_BUCKET_NAME:process.env.R2_BUCKET_NAME};
if(process.env.CLOUDFLARE_AI_GATEWAY_ID) config.vars.CLOUDFLARE_AI_GATEWAY_ID=process.env.CLOUDFLARE_AI_GATEWAY_ID;
if(process.env.SEARCH_ANSWER_DAILY_LIMIT) config.vars.SEARCH_ANSWER_DAILY_LIMIT=process.env.SEARCH_ANSWER_DAILY_LIMIT;
const temporary=`wrangler.configured.${process.pid}.tmp`;
try {
  await writeFile(temporary,JSON.stringify(config,null,2)+"\n",{mode:0o600,flag:"wx"});
  await rename(temporary,"wrangler.configured.jsonc");
} finally {await rm(temporary,{force:true});}
console.log("Wrote wrangler.configured.jsonc with existing resource IDs. Supply secrets with Wrangler before an owner-authorized deployment");

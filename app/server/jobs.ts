import type { Runtime } from "./runtime";
import { indexVideo, processStream, processVideo } from "./processing";
import { ProviderError, runSlackJob } from "./slack";
import { reviewVideo } from "./feedback";
import { prepareAgentRun, sweepAgentSchedules } from "./agents";

export async function runJobs(runtime:Runtime,limit=5,onlyId?:string) {
  if(!onlyId) await sweepAgentSchedules(runtime);
  let handled=0;
  while(handled<limit) {
    const claimed=await runtime.db.query(`WITH candidate AS (
      SELECT id,status AS previous_status FROM jobs WHERE ($1::text IS NULL OR id=$1) AND available_at<=now()
        AND (video_id IS NULL OR EXISTS(SELECT 1 FROM videos WHERE videos.id=jobs.video_id AND deleted_at IS NULL))
        AND (status IN ('pending','retry','uncertain') OR (status='running' AND lease_until<now()))
        ORDER BY created_at,CASE WHEN kind='stream' THEN 0 WHEN kind='process' THEN 1 ELSE 2 END,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE jobs j SET status='running',attempts=attempts+1,lease_until=now()+interval '1 hour',updated_at=now()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*,candidate.previous_status`,[onlyId||null]);
    const job=claimed.rows[0];if(!job) break;handled++;
    if(job.previous_status==="running"&&["slack_share","slack_comment","stream"].includes(job.kind)) job.previous_status="uncertain";
    try {
      const result:Record<string,unknown>=job.kind==="process"?await processVideo(runtime,job):job.kind==="stream"?await processStream(runtime,job):job.kind==="index"?await indexVideo(runtime,job):job.kind==="feedback"?await reviewVideo(runtime,job):job.kind==="agent_prepare"?await prepareAgentRun(runtime,job):await runSlackJob(runtime,job);
      const saved=await runtime.db.query("UPDATE jobs SET status='succeeded',lease_until=NULL,result=$2,external_id=$3,error=NULL,updated_at=now() WHERE id=$1 AND attempts=$4 AND status='running' AND lease_until>clock_timestamp() RETURNING id",[job.id,JSON.stringify(result),result.ts||result.uid||null,job.attempts]);
      if(!saved.rowCount) continue;
      if(job.video_id&&job.kind.startsWith("slack")) await runtime.db.query("UPDATE slack_threads SET error=NULL WHERE video_id=$1",[job.video_id]);
    } catch(error) {
      const message=(error instanceof Error?error.message:"Processing failed").slice(0,1000);
      const provider=error instanceof ProviderError?error:null;
      const uncertain=!!provider?.uncertain||(job.previous_status==="running"&&(job.kind==="slack_share"||job.kind==="slack_comment"));
      const status=uncertain?"uncertain":provider?.blocked?"blocked":job.attempts>=8?"error":"retry";
      const seconds=provider?.retryAfter||Math.min(3600,2**Math.min(job.attempts,10)*10);
      const saved=await runtime.db.query("UPDATE jobs SET status=$2,error=$3,lease_until=NULL,available_at=now()+($4::text||' seconds')::interval,updated_at=now() WHERE id=$1 AND attempts=$5 AND status='running' AND lease_until>clock_timestamp() RETURNING id",[job.id,status,message,seconds,job.attempts]);
      if(!saved.rowCount) continue;
      if(job.video_id) {
        if(job.kind==="process") await runtime.db.query("UPDATE videos SET ai_status=$2,processing_error=$3 WHERE id=$1",[job.video_id,provider?.blocked?"needs_setup":"error",message]);
        if(job.kind.startsWith("slack")) await runtime.db.query("UPDATE slack_threads SET error=$2 WHERE video_id=$1",[job.video_id,`${status}: ${message}`]);
      }
    }
  }
  return {handled};
}
export async function dispatchOutbox(runtime:Runtime) {
  await sweepAgentSchedules(runtime);
  if(!runtime.enqueue) return;
  const due=await runtime.db.query("SELECT id FROM jobs WHERE available_at<=now() AND (video_id IS NULL OR EXISTS(SELECT 1 FROM videos WHERE videos.id=jobs.video_id AND deleted_at IS NULL)) AND (status IN ('pending','retry','uncertain') OR (status='running' AND lease_until<now())) ORDER BY created_at,CASE WHEN kind='stream' THEN 0 WHEN kind='process' THEN 1 ELSE 2 END,id LIMIT 50");
  for(const row of due.rows) await runtime.enqueue(row.id);
}

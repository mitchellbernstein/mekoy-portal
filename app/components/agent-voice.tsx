import { useState, type FormEvent } from "react";
import { voiceConsentVersion } from "../../shared/agent-templates";
import type { VoiceSetup } from "../../shared/agent-templates";
import { api, errorMessage, useApi, write } from "./api";
import { Notice } from "./ui";

const statuses={creating:"Creating voice",ready:"Ready for your demos",verification_required:"Speaker verification needed",uncertain:"Provider outcome needs checking",failed:"Voice creation failed",deleting:"Deleting voice",delete_failed:"Locally revoked. Remote deletion needs checking"};

export function PersonalVoice({busy,setBusy}:{busy:boolean;setBusy:(value:boolean)=>void}) {
  const {data,error,reload}=useApi<VoiceSetup>("/api/agents/voice");
  const [failure,setFailure]=useState("");
  const [confirmDelete,setConfirmDelete]=useState(false);
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
  async function create(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setFailure("");
    const form=new FormData(event.currentTarget);form.set("consentVersion",voiceConsentVersion);form.set("requestId",requestId);
    try {await api<VoiceSetup>("/api/agents/voice",{method:"POST",body:form});}
    catch(error) {setFailure(errorMessage(error));}
    finally {setBusy(false);reload();}
  }
  async function remove() {
    setBusy(true);setFailure("");
    try {const result=await write<VoiceSetup>("/api/agents/voice","DELETE");if(!result.profile) {setRequestId(crypto.randomUUID());setConfirmDelete(false);}}
    catch(error) {setFailure(errorMessage(error));}
    finally {setBusy(false);reload();}
  }
  async function check() {
    setBusy(true);setFailure("");
    try {await write("/api/agents/voice/check","POST");}
    catch(error) {setFailure(errorMessage(error));}
    finally {setBusy(false);reload();}
  }
  return <section className="agent-settings-section"><h3>Your narration voice</h3><p>Create a private clone of your own voice with ElevenLabs. Choose it when you request a video. Every video identifies its AI narration.</p>
    {(error||failure)&&<Notice error>{failure||error}</Notice>}
    {!data?<p role="status">{error?<button className="text-button" onClick={reload}>Retry voice setup</button>:"Loading your voice…"}</p>:<>
      {!data.configured&&<p>Ask your workspace operator to configure ElevenLabs voice creation, voice read and deletion, and speech access with a credit limit.</p>}
      {data.profile?<><div className="agent-provider"><span className={`agent-connection-dot ${data.profile.status==="ready"?"connected":""}`}/><div><strong>{data.profile.name}'s voice</strong><p>{statuses[data.profile.status]}</p></div></div>{data.profile.error&&<Notice error>{data.profile.error}</Notice>}
        {data.profile.status==="verification_required"&&<p>Ask your workspace operator to arrange ElevenLabs speaker verification with you. Once complete, <button className="text-button" disabled={busy||!data.configured} onClick={check}>Check verification</button>.</p>}
        {confirmDelete?<div className="agent-disconnect-confirm" role="group" aria-label="Confirm voice deletion"><p>Stop future use of your voice and delete its ElevenLabs clone? Existing videos keep their generated audio. Delete those videos separately if needed.</p><div><button className="button" disabled={busy} onClick={()=>setConfirmDelete(false)}>Cancel</button><button className="button danger" disabled={busy} onClick={remove}>{busy?"Deleting…":"Revoke and delete my voice"}</button></div></div>:<button className="text-button danger" disabled={busy} onClick={()=>setConfirmDelete(true)}>{data.profile.status==="delete_failed"?"Retry voice deletion":"Delete voice"}</button>}
      </>:<form className="stack-form" onSubmit={create}>
        <label>Your voice sample<input name="sample" type="file" accept="audio/mpeg,audio/wav,audio/x-wav" required disabled={busy||!data.configured}/></label>
        <p>Use 1 to 2 minutes of your own clear speech as an MP3 or WAV up to 8 MiB. The sample is sent privately to ElevenLabs. Your workspace does not keep a playable sample.</p>
        <p>Team-owner access is required. You can attempt 3 clones per 30 days. Deleted and failed clones still count.</p>
        <label className="agent-checkbox"><input name="consent" type="checkbox" value="yes" required disabled={busy||!data.configured}/>I am the speaker. I consent to ElevenLabs cloning my own voice for AI narration in videos I request, including repository headings, supplied context, and observed on-screen text.</label>
        <p>ElevenLabs stores the clone under your workspace operator's provider account and policies. Deleting your voice stops future use and requests remote deletion. Previously saved videos keep their audio.</p>
        <button className="button" disabled={busy||!data.configured}>{busy?"Creating voice…":"Upload and clone my voice"}</button>
      </form>}
    </>}
  </section>;
}

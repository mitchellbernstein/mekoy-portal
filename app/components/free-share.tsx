import { useEffect, useState } from "react";
import type { ShareLink } from "../../shared/contracts";
import { api, errorMessage, write } from "./api";
import { Icon, Modal, Notice } from "./ui";

export function FreeShareDialog({videoId,canIssue,onClose}:{videoId:string;canIssue:boolean;onClose:()=>void}) {
  const [link,setLink]=useState<ShareLink|null>(null);
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState("");
  const [copied,setCopied]=useState(false);
  const path=`/api/videos/${encodeURIComponent(videoId)}/share-link`;
  useEffect(()=>{
    let active=true;
    api<{link:ShareLink|null}>(path).then(async result=>{
      let existing=result.link;
      if(!existing&&canIssue) existing=(await write<{link:ShareLink}>(path,"POST")).link;
      if(active) setLink(existing);
    }).catch(failure=>{if(active) setError(errorMessage(failure));}).finally(()=>{if(active) setBusy(false);});
    return ()=>{active=false;};
  },[path,canIssue]);
  async function change(replace:boolean) {
    setBusy(true);setError("");setCopied(false);
    try {
      if(replace) setLink((await write<{link:ShareLink}>(`${path}/replace`,"POST")).link);
      else {await write(path,"DELETE");setLink(previous=>previous&&{...previous,status:"revoked"});}
    } catch(failure) {setError(errorMessage(failure));}
    finally {setBusy(false);}
  }
  return <Modal title={canIssue?"Share for 7 days":"Viewing link"} onClose={onClose} busy={busy}><p className="form-intro">Active viewing links let anyone watch. Comments and transcripts stay in your workspace.</p>{busy&&!link&&<p role="status"><span className="spinner"/>Opening the viewing link...</p>}{link&&<><label className="field-label" htmlFor="free-share-link">Viewing link</label><div className="copy-link"><input id="free-share-link" value={link.url} readOnly onFocus={event=>event.target.select()}/><button className="button primary" disabled={busy||link.status!=="active"} onClick={async()=>{try {await navigator.clipboard.writeText(link.url);setCopied(true);} catch {setError("Select and copy the link above. Clipboard access is unavailable in this browser.");}}}>{copied?<><Icon name="check" size={16}/>Copied</>:"Copy link"}</button></div><p className="form-help">{link.status==="active"?<>Expires <time dateTime={link.expiresAt}>{new Date(link.expiresAt).toLocaleString()}</time>. Your recording stays available to you.</>:link.status==="expired"?"This link expired. Your recording is still available to you.":"This link has ended. Your recording is still available to you."}</p>{canIssue&&<p className="form-help">Replacing the link ends the previous link and starts a new 7-day period.</p>}<p className="form-help">Ending a link blocks new access. People who already loaded the video may finish watching.</p><footer className="modal-footer">{link.status==="active"&&<button className="button" disabled={busy} onClick={()=>void change(false)}>End link</button>}{canIssue&&<button className="button" disabled={busy} onClick={()=>void change(true)}>Replace link</button>}</footer></>}{!busy&&!link&&!error&&<p>No viewing link exists for this recording.</p>}{error&&<Notice error>{error}</Notice>}</Modal>;
}

import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import type { SharedVideo } from "../../shared/contracts";
import { useApi } from "../components/api";
import { MediaPlayer, type PlayerHandle } from "../components/player";
import { Notice } from "../components/ui";
import "../shared-video.css";

export function meta() {
  return [{title:"Shared recording"},{name:"robots",content:"noindex, nofollow, noarchive"},{name:"referrer",content:"no-referrer"}];
}

export function headers() {
  return {"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Robots-Tag":"noindex, nofollow, noarchive"};
}

export default function SharedRecording() {
  const {token}=useParams();
  const {data,error,loading,reload}=useApi<{video:SharedVideo}>(`/api/shared/${encodeURIComponent(token||"")}`);
  const player=useRef<PlayerHandle>(null);
  const [position,setPosition]=useState(0);
  const [duration,setDuration]=useState(0);
  const [mediaError,setMediaError]=useState("");
  const [expired,setExpired]=useState(false);
  useEffect(()=>{
    if(!data) return;
    const remaining=new Date(data.video.expiresAt).getTime()-Date.now();
    setExpired(remaining<=0);
    const timer=window.setTimeout(()=>setExpired(true),Math.max(0,remaining));
    return ()=>window.clearTimeout(timer);
  },[data]);
  if(loading) return <main className="standalone-state"><p><span className="spinner"/>Opening recording...</p></main>;
  if(!data||expired) return <main className="standalone-state"><h1>This viewing link is unavailable</h1><p>It may have expired or ended. Ask the owner for a new link.</p>{error&&<button className="button" onClick={reload}>Try again</button>}</main>;
  const video=data.video;
  function seek(ms:number) {setPosition(ms);player.current?.seek(ms);}
  return <main className="shared-video-page"><header><p className="subtle">Shared recording</p><h1>{video.title}</h1><p>This link expires <time dateTime={video.expiresAt}>{new Date(video.expiresAt).toLocaleString()}</time>.</p></header><div className="player-frame"><MediaPlayer key={token} ref={player} video={video} playbackUrl={video.playbackUrl} allowOriginal={false} position={position} duration={duration||video.durationMs} markers={[]} chapters={video.chapters} onSeek={seek} onTimeUpdate={setPosition} onDuration={setDuration} onReady={()=>setMediaError("")} onPlay={()=>{}} onError={setMediaError}/></div>{mediaError&&<Notice error>{mediaError}</Notice>}</main>;
}

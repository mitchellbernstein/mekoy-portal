import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "./ui";

let activePreview: (() => void) | null = null;
type Props = { videoId: string; accountKey: string; link: RefObject<HTMLAnchorElement | null> };

export function CardPreview(props: Props) {
  return <PreviewImage key={`${props.accountKey}/${props.videoId}`} {...props}/>;
}
function PreviewImage({ videoId, accountKey, link }: Props) {
  const [loop, setLoop] = useState<number | null>(null);
  const [imageKey, setImageKey] = useState("");
  const [posterAttempt, setPosterAttempt] = useState(0);
  const [posterFailed, setPosterFailed] = useState(false);
  const failedPoster = useRef(false);
  const generation = useRef(0);
  const path = `/api/videos/${encodeURIComponent(videoId)}/preview`;
  useEffect(() => { setImageKey(crypto.randomUUID()); }, []);
  useEffect(() => {
    const card = link.current; if (!card) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarse = window.matchMedia("(pointer: coarse)");
    const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retriedPoster = false;
    let visible = true;
    const stop = () => { generation.current++; clearTimeout(timer); setLoop(null); if (activePreview === stop) activePreview = null; };
    const motionSupported = typeof IntersectionObserver !== "undefined";
    const blocked = () => document.hidden || !visible || !motionSupported || reduced.matches || coarse.matches || connection?.saveData;
    const start = () => {
      const bounds = card.getBoundingClientRect();
      if (document.hidden || bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= window.innerHeight || bounds.left >= window.innerWidth) return;
      if (failedPoster.current && !retriedPoster) { retriedPoster = true; failedPoster.current = false; setPosterFailed(false); setPosterAttempt(1); }
      if (blocked() || activePreview === stop) return;
      activePreview?.(); activePreview = stop;
      const request = ++generation.current;
      timer = setTimeout(() => { if (generation.current === request && !blocked()) setLoop(request); }, 250);
    };
    const pointer = (event: PointerEvent) => { if (event.pointerType !== "touch") start(); };
    const preference = () => { if (blocked()) stop(); };
    const observer = motionSupported ? new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting || false; if (!visible) stop(); else if (card.matches(":focus-visible")) start(); }) : null;
    observer?.observe(card);
    card.addEventListener("pointerenter", pointer); card.addEventListener("pointerleave", stop);
    card.addEventListener("focus", start); card.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", preference);
    reduced.addEventListener("change", preference); coarse.addEventListener("change", preference); connection?.addEventListener("change", preference);
    return () => {
      stop(); observer?.disconnect();
      card.removeEventListener("pointerenter", pointer); card.removeEventListener("pointerleave", stop);
      card.removeEventListener("focus", start); card.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", preference);
      reduced.removeEventListener("change", preference); coarse.removeEventListener("change", preference); connection?.removeEventListener("change", preference);
    };
  }, [videoId, accountKey, link]);
  return <>
    {posterFailed || !imageKey ? <Icon name="video" size={26}/> : <img key={posterAttempt} className="card-preview-poster" src={`${path}?format=jpg&request=${imageKey}-${posterAttempt}`} loading="lazy" decoding="async" alt="" aria-hidden="true" onError={() => { failedPoster.current = true; setPosterFailed(true); }}/>}
    {loop !== null && imageKey && <img key={loop} className="card-preview-loop" src={`${path}?format=gif&request=${imageKey}-${loop}`} alt="" aria-hidden="true" onError={() => { if (generation.current === loop) setLoop(null); }}/>}
  </>;
}

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Video, VideoChapter } from "../../shared/contracts";
import { readVideoChapters } from "../../shared/video-chapters";
import { time, useApi } from "./api";
import { Icon } from "./ui";
import "../player-polish.css";

type StreamPlayer = {
  currentTime: number;
  duration: number;
  controls: boolean;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
  play: () => Promise<void>;
  pause: () => void;
  addEventListener: (event: string, listener: () => void) => void;
  removeEventListener: (event: string, listener: () => void) => void;
};
type StreamFactory = (iframe: HTMLIFrameElement) => StreamPlayer;
declare global { interface Window { Stream?: StreamFactory } }

let streamSdk: Promise<StreamFactory> | null = null;
function loadStreamSdk(): Promise<StreamFactory> {
  if (window.Stream) return Promise.resolve(window.Stream);
  if (!streamSdk) {
    streamSdk = new Promise<StreamFactory>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://embed.cloudflarestream.com/embed/sdk.latest.js";
      script.async = true;
      const timer = window.setTimeout(() => fail(), 15000);
      const fail = () => { window.clearTimeout(timer); script.remove(); reject(new Error("The hosted player controls couldn’t load.")); };
      script.onload = () => { window.clearTimeout(timer); if (window.Stream) resolve(window.Stream); else fail(); };
      script.onerror = fail;
      document.head.append(script);
    }).catch(error => { streamSdk = null; throw error; });
  }
  return streamSdk;
}

export type PlayerHandle = { seek: (ms: number) => void };
export type MediaPlayerMarker = { positionMs: number; label: string; emoji?: string; count: number };
export type MediaPlayerProps = {
  video: Pick<Video,"title"|"durationMs"|"mediaUrl">;
  playbackUrl: string;
  allowOriginal?: boolean;
  position: number;
  duration: number;
  markers: MediaPlayerMarker[];
  chapters: VideoChapter[];
  onSeek: (ms: number) => void;
  onTimeUpdate: (ms: number) => void;
  onDuration: (ms: number) => void;
  onReady: () => void;
  onPlay: () => void;
  onError: (message: string) => void;
};
type PlaybackState = { status: "loading" | "paused" | "playing" | "buffering" | "ended" | "error"; muted: boolean; volume: number; rate: number };
type Media = HTMLVideoElement | StreamPlayer;

export const MediaPlayer = forwardRef<PlayerHandle, MediaPlayerProps>(function MediaPlayer(props, ref) {
  const { video } = props;
  const { data, error, loading, reload } = useApi<{ mediaUrl: string; streamUrl: string | null }>(props.playbackUrl);
  const allowOriginal = props.allowOriginal ?? true;
  const container = useRef<HTMLDivElement>(null);
  const native = useRef<HTMLVideoElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const hosted = useRef<StreamPlayer | null>(null);
  const muteButton = useRef<HTMLButtonElement>(null);
  const volumeGroup = useRef<HTMLDivElement>(null);
  const speedButton = useRef<HTMLButtonElement>(null);
  const speedPanel = useRef<HTMLFieldSetElement>(null);
  const chapterButton = useRef<HTMLButtonElement>(null);
  const chapterPanel = useRef<HTMLDivElement>(null);
  const lastVolume = useRef(1);
  const preferences = useRef({ muted: false, volume: 1, rate: 1 });
  const pending = useRef(0);
  const ready = useRef(false);
  const seeking = useRef<number | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [useOriginal, setUseOriginal] = useState(false);
  const [playback, setPlayback] = useState<PlaybackState>({ status: "loading", muted: false, volume: 1, rate: 1 });
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  const [panel, setPanel] = useState<"volume" | "speed" | "chapters" | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const playerId = useId();
  const streamUrl = useOriginal ? null : data?.streamUrl;
  const mediaUrl = data?.mediaUrl || video.mediaUrl;
  const total = Math.max(0, props.duration || video.durationMs || 0);
  const position = Math.max(0, Math.min(props.position, total));
  const chapters = readVideoChapters(props.chapters, total);
  const available = playback.status !== "loading" && playback.status !== "error";
  const playing = playback.status === "playing" || playback.status === "buffering";
  const playLabel = playing ? "Pause" : playback.status === "ended" ? "Replay" : "Play";
  const muted = playback.muted || playback.volume === 0;

  function syncMedia(media: Media, status?: PlaybackState["status"]) {
    if (!ready.current) return;
    preferences.current = { muted: media.muted, volume: media.volume, rate: "playbackRate" in media ? media.playbackRate : preferences.current.rate };
    setPlayback(previous => ({ ...preferences.current, status: status ?? (media.ended ? "ended" : media.paused ? "paused" : previous.status === "buffering" ? "buffering" : "playing") }));
  }

  function buffering(media: Media) {
    if (ready.current && !media.paused) syncMedia(media, "buffering");
  }

  function updateTime(media: Media) {
    if (!ready.current || !Number.isFinite(media.currentTime)) return;
    const ms = Math.round(media.currentTime * 1000);
    // Stream can report the old time before an asynchronous seek settles.
    if (seeking.current !== null && Math.abs(ms - seeking.current) > 500) return;
    seeking.current = null;
    pending.current = ms;
    callbacks.current.onTimeUpdate(ms);
  }

  function updateDuration(media: Media) {
    if (Number.isFinite(media.duration) && media.duration > 0) callbacks.current.onDuration(Math.round(media.duration * 1000));
  }

  function seek(ms: number) {
    const media = hosted.current || native.current;
    pending.current = Math.max(0, ms);
    if (ready.current && media && media.duration > 0) {
      pending.current = Math.min(pending.current, Math.round(media.duration * 1000));
      seeking.current = pending.current;
      media.currentTime = pending.current / 1000;
    }
  }

  function mediaReady(media: Media) {
    media.volume = preferences.current.volume;
    media.muted = preferences.current.muted;
    if ("playbackRate" in media) media.playbackRate = preferences.current.rate;
    updateDuration(media);
    ready.current = true;
    seek(pending.current);
    syncMedia(media);
    callbacks.current.onReady();
  }

  async function togglePlayback() {
    const media = hosted.current || native.current;
    if (!media || !available) return;
    if (media.ended) callbacks.current.onSeek(0);
    else if (!media.paused) { media.pause(); return; }
    try { await media.play(); }
    catch { if (media === (hosted.current || native.current)) callbacks.current.onError(allowOriginal ? "Playback could not start. Try Play again, or use the original video." : "Playback could not start. Try Play again."); }
  }

  function rememberVolume() {
    const media = hosted.current || native.current;
    if (media && media.volume > 0) lastVolume.current = media.volume;
  }

  function toggleMute() {
    const media = hosted.current || native.current;
    if (!media || !available) return;
    if (media.muted || media.volume === 0) {
      if (media.volume === 0) media.volume = lastVolume.current;
      media.muted = false;
    } else { rememberVolume(); media.muted = true; }
    syncMedia(media);
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (event.key === "Escape" && panel) {
      event.preventDefault(); event.stopPropagation();
      const trigger = panel === "speed" ? speedButton.current : panel === "chapters" ? chapterButton.current : volumeGroup.current?.contains(document.activeElement) ? muteButton.current : null;
      setPanel(null);
      trigger?.focus({ preventScroll: true });
      return;
    }
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || target.closest("button, input, select, textarea, a, [contenteditable], [role=slider]")) return;
    if (event.key === " " || event.key === "Spacebar" || event.key.toLowerCase() === "k") { event.preventDefault(); if (!event.repeat) void togglePlayback(); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      if (available) callbacks.current.onSeek(Math.max(0, Math.min(total, pending.current + (event.key === "ArrowLeft" ? -5000 : 5000))));
    } else if (event.key.toLowerCase() === "m") { event.preventDefault(); if (!event.repeat) toggleMute(); }
    else if (event.key.toLowerCase() === "f" && fullscreenAvailable) { event.preventDefault(); if (!event.repeat) void toggleFullscreen(); }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === container.current) await document.exitFullscreen();
      else await container.current?.requestFullscreen();
    } catch { callbacks.current.onError("Fullscreen could not open in this browser. You can keep watching here."); }
  }

  useImperativeHandle(ref, () => ({ seek }), []);

  useEffect(() => {
    setFullscreenAvailable(document.fullscreenEnabled && typeof container.current?.requestFullscreen === "function");
    const changed = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  useEffect(() => {
    if (!panel) return;
    if (panel === "speed") speedPanel.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    if (panel === "chapters") (chapterPanel.current?.querySelector<HTMLButtonElement>("[aria-current=true]") || chapterPanel.current?.querySelector("button"))?.focus();
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !container.current?.contains(target) || !target.closest("[data-player-popup]")) setPanel(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [panel]);

  useEffect(() => {
    ready.current = false;
    seeking.current = null;
    setPanel(null);
    setPlayback(previous => ({ ...previous, status: "loading" }));
    if (!streamUrl) return;
    let active = true;
    let instance: StreamPlayer | null = null;
    const readyPlayer = () => { if (instance && !ready.current && Number.isFinite(instance.duration) && instance.duration > 0) mediaReady(instance); };
    const updated = () => { if (instance) updateTime(instance); };
    const durationChanged = () => { if (!ready.current) readyPlayer(); else if (instance) updateDuration(instance); };
    const changed = () => { if (instance) syncMedia(instance); };
    const seeked = () => { updated(); changed(); };
    const played = () => { changed(); callbacks.current.onPlay(); };
    const resumed = () => { readyPlayer(); if (instance) syncMedia(instance, instance.ended ? "ended" : instance.paused ? "paused" : "playing"); };
    const waiting = () => { if (instance) buffering(instance); };
    const failed = () => { if (active) { callbacks.current.onError("Hosted playback is unavailable. Using the original recording."); setUseOriginal(true); } };
    const listeners: [string, () => void][] = [["timeupdate", updated], ["seeked", seeked], ["durationchange", durationChanged], ["loadedmetadata", readyPlayer], ["play", played], ["playing", resumed], ["canplay", resumed], ["waiting", waiting], ["pause", changed], ["ended", changed], ["volumechange", changed], ["error", failed]];
    loadStreamSdk().then(createPlayer => {
      if (!active || !iframe.current) return;
      instance = createPlayer(iframe.current);
      hosted.current = instance;
      instance.controls = false;
      listeners.forEach(([event, listener]) => instance?.addEventListener(event, listener));
      if (instance.duration > 0) readyPlayer();
    }).catch(failed);
    return () => {
      active = false;
      if (instance) { listeners.forEach(([event, listener]) => instance?.removeEventListener(event, listener)); instance.pause(); }
      hosted.current = null;
    };
  }, [streamUrl, mediaUrl]);

  const iframeUrl = streamUrl ? new URL(streamUrl) : null;
  iframeUrl?.searchParams.set("controls", "false");

  return <div ref={container} className="media-player polished-player" role="group" aria-label={`${video.title} video player`} aria-keyshortcuts="Space K ArrowLeft ArrowRight M F" tabIndex={0} onKeyDown={keyboard} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPanel(null); }}>
    {loading && !data && !useOriginal ? <div className="pending-video"><span className="spinner" /><p>Opening recording…</p></div>
      : error && !useOriginal ? <div className="pending-video"><Icon name="video" size={30} /><p>{error}</p><div className="player-recovery-actions"><button className="button" onClick={reload}>Try again</button>{allowOriginal && <button className="button" onClick={() => setUseOriginal(true)}>Play original</button>}</div></div>
      : streamUrl ? <><iframe ref={iframe} title={video.title} src={iframeUrl!.toString()} tabIndex={-1} allow="accelerometer; gyroscope; autoplay; encrypted-media; fullscreen" allowFullScreen />{allowOriginal && <button className="player-original-button" onClick={() => setUseOriginal(true)}>Use original video</button>}</>
      : <video ref={native} src={mediaUrl} controls={false} playsInline preload="metadata" aria-label={video.title} tabIndex={-1} onTimeUpdate={event => updateTime(event.currentTarget)} onSeeked={event => { updateTime(event.currentTarget); syncMedia(event.currentTarget); }} onDurationChange={event => updateDuration(event.currentTarget)} onPause={event => syncMedia(event.currentTarget)} onEnded={event => syncMedia(event.currentTarget)} onVolumeChange={event => syncMedia(event.currentTarget)} onRateChange={event => syncMedia(event.currentTarget)} onWaiting={event => buffering(event.currentTarget)} onPlaying={event => syncMedia(event.currentTarget, "playing")} onCanPlay={event => syncMedia(event.currentTarget, event.currentTarget.ended ? "ended" : event.currentTarget.paused ? "paused" : "playing")} onPlay={event => { syncMedia(event.currentTarget); props.onPlay(); }} onError={() => { ready.current = false; setPlayback(previous => ({ ...previous, status: "error" })); props.onError(allowOriginal ? "This video could not be played. Try again, or open the original file in a browser that supports its format." : "This recording could not be played. Try again or ask its owner to check the recording."); }} onLoadedMetadata={event => mediaReady(event.currentTarget)} />}
    {available && <button type="button" className="player-canvas-toggle" tabIndex={-1} aria-label={`${playLabel} video`} onClick={() => { container.current?.focus({ preventScroll: true }); void togglePlayback(); }}>{!playing && <span className="player-center-play" aria-hidden="true"><Icon name="play" size={28} /></span>}</button>}
    {((playback.status === "loading" && !loading && !error) || playback.status === "buffering") && <div className="player-state" role="status"><span className="spinner" /><span>{playback.status === "buffering" ? "Buffering…" : "Loading video…"}</span></div>}
    {playback.status === "error" && <div className="player-media-error"><p>This recording could not be played.</p><button className="button" onClick={() => { setPlayback(previous => ({ ...previous, status: "loading" })); native.current?.load(); }}>Try again</button></div>}
    <div className="player-controls" role="group" aria-label="Playback controls">
      <div className="timeline" role="group" aria-label="Comments and playback timeline">
        {chapters.length > 0 && <div className="timeline-chapters" aria-hidden="true">{chapters.map(chapter => <span className="timeline-chapter-segment" key={chapter.startMs} style={{ left: `${chapter.startMs / total * 100}%`, width: `${(chapter.endMs - chapter.startMs) / total * 100}%` }} />)}</div>}
        <div className="timeline-markers">{props.markers.map((marker, index) => <button type="button" className="timeline-marker" key={`${marker.positionMs}-${index}`} style={{ left: `${total > 0 ? Math.max(0, Math.min(100, marker.positionMs / total * 100)) : 0}%` }} disabled={!available || total <= 0} onClick={() => props.onSeek(marker.positionMs)} aria-label={`${time(marker.positionMs)}. ${marker.label}`} title={`${time(marker.positionMs)} · ${marker.label}`}>{marker.emoji ? <span aria-hidden="true">{marker.emoji}</span> : <Icon name="comment" size={17} />}{marker.count > 1 && <small aria-hidden="true">{marker.count}</small>}</button>)}</div>
        {hoverTime !== null && available && <output className="player-seek-preview" aria-hidden="true" style={{ left: `clamp(26px, ${total > 0 ? hoverTime / total * 100 : 0}%, calc(100% - 26px))` }}>{time(hoverTime)}</output>}
        <input type="range" min="0" max={Math.max(total, 1)} step="1" value={position} disabled={!available || total <= 0} aria-label="Playback position" aria-valuetext={`${time(position)} of ${time(total)}`} onChange={event => props.onSeek(Number(event.target.value))} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); props.onSeek(Math.max(0, Math.min(total, position + (["ArrowLeft", "ArrowDown"].includes(event.key) ? -1000 : 1000)))); } }} onPointerMove={event => { if (event.pointerType !== "mouse") return; const bounds = event.currentTarget.getBoundingClientRect(); setHoverTime(Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left - 7) / Math.max(1, bounds.width - 14))) * total)); }} onPointerLeave={() => setHoverTime(null)} style={{ "--played": `${total > 0 ? position / total * 100 : 0}%` } as CSSProperties} />
      </div>
      <div className="player-control-row">
        <button type="button" className="player-control player-play" aria-label={playLabel} title={`${playLabel} (Space / K)`} disabled={!available} onClick={() => void togglePlayback()}><Icon name={playing ? "pause" : "play"} size={20} /></button>
        <span className="player-time" aria-label={`${time(position)} of ${time(total)}`}><span>{time(position)}</span><span className="player-time-total"><span>/</span>{time(total)}</span></span>
        <div ref={volumeGroup} className="player-volume-group" data-player-popup onPointerEnter={event => { if (available && event.pointerType === "mouse" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) setPanel("volume"); }} onPointerLeave={() => { if (!volumeGroup.current?.contains(document.activeElement)) setPanel(current => current === "volume" ? null : current); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPanel(current => current === "volume" ? null : current); }}>
          <button ref={muteButton} type="button" className="player-control" aria-label={muted ? "Unmute" : "Mute"} aria-controls={`${playerId}-volume`} aria-expanded={panel === "volume"} title={`${muted ? "Unmute" : "Mute"} (M)`} disabled={!available} onFocus={event => { if (!volumeGroup.current?.contains(event.relatedTarget)) setPanel("volume"); }} onClick={() => { toggleMute(); setPanel("volume"); }}><Icon name={muted ? "volume-off" : "volume"} size={19} /></button>
          {panel === "volume" && <div id={`${playerId}-volume`} className="player-popover player-volume-popover"><div className="player-volume-heading"><span>Volume</span><output>{Math.round(playback.volume * 100)}%</output></div><input type="range" min="0" max="100" step="1" onFocus={rememberVolume} onPointerDown={rememberVolume} value={Math.round(playback.volume * 100)} aria-label="Volume" aria-valuetext={`${Math.round(playback.volume * 100)} percent${muted ? ", muted" : ""}`} disabled={!available} onChange={event => { const media = hosted.current || native.current; if (media) { media.volume = Number(event.target.value) / 100; media.muted = media.volume === 0; syncMedia(media); } }} style={{ "--volume": `${playback.volume * 100}%` } as CSSProperties} /></div>}
        </div>
        {!streamUrl && <button ref={speedButton} type="button" className="player-control player-speed" data-player-popup aria-label={`Playback speed, ${playback.rate}×`} aria-expanded={panel === "speed"} aria-controls={`${playerId}-speed`} disabled={!available} onClick={() => setPanel(current => current === "speed" ? null : "speed")}><span>{playback.rate}×</span></button>}
        {chapters.length > 0 && <button ref={chapterButton} type="button" className="player-control" data-player-popup aria-label="Video chapters" title="Video chapters" aria-expanded={panel === "chapters"} aria-controls={`${playerId}-chapters`} disabled={!available} onClick={() => setPanel(current => current === "chapters" ? null : "chapters")}><Icon name="menu" size={19} /></button>}
        <button type="button" className="player-control" aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} title={fullscreenAvailable ? fullscreen ? "Exit fullscreen" : "Enter fullscreen" : "Fullscreen is unavailable in this browser"} disabled={!fullscreenAvailable} onClick={() => void toggleFullscreen()}><Icon name={fullscreen ? "exit-fullscreen" : "fullscreen"} size={19} /></button>
      </div>
    </div>
    {panel === "speed" && !streamUrl && <fieldset ref={speedPanel} id={`${playerId}-speed`} className="player-popover player-speed-popover" data-player-popup onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); setPanel(null); speedButton.current?.focus({ preventScroll: true }); } }}><legend>Playback speed</legend>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => <label key={rate}><input type="radio" name={`${playerId}-rate`} value={rate} checked={playback.rate === rate} onChange={() => { if (native.current) { native.current.playbackRate = rate; syncMedia(native.current); } }} /><span>{rate}×{rate === 1 && <small>Normal</small>}</span><Icon name="check" size={15} /></label>)}</fieldset>}
    {panel === "chapters" && chapters.length > 0 && <div ref={chapterPanel} id={`${playerId}-chapters`} className="player-popover player-chapters-popover" data-player-popup role="group" aria-label="Video chapters">{chapters.map(chapter => <button type="button" className="timeline-chapter" key={chapter.startMs} aria-current={position >= chapter.startMs && position < chapter.endMs ? "true" : undefined} onClick={() => { props.onSeek(chapter.startMs); setPanel(null); chapterButton.current?.focus({ preventScroll: true }); }}><span>{time(chapter.startMs)}</span><span>{chapter.title}</span></button>)}</div>}
  </div>;
});

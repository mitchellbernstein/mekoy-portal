import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Bootstrap, UploadInput, UploadPreparation, UploadReceipt } from "../../shared/contracts";
import { errorMessage, time, write } from "./api";
import { Icon, Modal, Notice } from "./ui";

export function UploadDialog({ bootstrap, initialTeamId, initialFolderId, onClose, onComplete }: { bootstrap: Bootstrap; initialTeamId?: string; initialFolderId?: string; onClose: () => void; onComplete: (id: string) => void }) {
  const folder = bootstrap.folders.find(item => item.id === initialFolderId);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [teamId, setTeamId] = useState(bootstrap.account.canOrganize?(initialTeamId || folder?.teamId || ""):"");
  const [folderId, setFolderId] = useState(bootstrap.account.canOrganize?(initialFolderId || ""):"");
  const [duration, setDuration] = useState<number | null>(null);
  const [fileError, setFileError] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState("");
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const preparation = useRef<UploadPreparation | null>(null);
  const recordingId = useRef("");
  const bytesSent = useRef(false);

  useEffect(() => {
    if (!file) return;
    let active = true;
    const url = URL.createObjectURL(file);
    const media = document.createElement("video");
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      if (!active) return;
      if (Number.isFinite(media.duration) && media.duration > 0) setDuration(Math.round(media.duration * 1000));
      else setFileError("This video has no readable duration. Choose a completed video file.");
    };
    media.onerror = () => { if (active) setFileError("Your browser couldn’t read this video. Try an MP4 or WebM file."); };
    media.src = url;
    return () => { active = false; media.removeAttribute("src"); media.load(); URL.revokeObjectURL(url); };
  }, [file]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || duration === null) return;
    setBusy(true);
    setError("");
    try {
      let ready = preparation.current;
      if (!ready || !bytesSent.current) {
        setStep("1 of 3 · Preparing your upload…");
        const input: UploadInput = { recordingId: recordingId.current, title: title.trim(), mimeType: file.type || "video/mp4", byteLength: file.size, durationMs: duration, teamId: teamId || null, folderId: folderId || null };
        ready = await write<UploadPreparation>("/api/uploads", "POST", input);
        preparation.current = ready;
        setPrepared(true);
      }
      if (!bytesSent.current) {
        setStep("2 of 3 · Uploading your video. Keep this window open…");
        const target = new URL(ready.upload.url, window.location.origin);
        const response = await fetch(target, { method: ready.upload.method, headers: ready.upload.headers, body: file, credentials: target.origin === window.location.origin ? "same-origin" : "omit" });
        if (!response.ok) {
          const result = await response.json().catch(() => null);
          throw new Error(result?.error || `Upload failed (${response.status}). Your original file is unchanged; retry this upload.`);
        }
        bytesSent.current = true;
      }
      setStep("3 of 3 · Saving your recording…");
      const receipt = await write<UploadReceipt>(ready.completeUrl, "POST");
      if (receipt.receipt?.durable !== true) throw new Error("The server has not confirmed durable storage. Keep your original file and retry.");
      onComplete(receipt.video.id);
    } catch (failure) { setError(errorMessage(failure)); setStep(""); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Upload a video" onClose={onClose} busy={busy}>
      <form onSubmit={upload} className="stack-form">
        <p className="form-intro">Bring a recording into your workspace. Your original file stays on your computer.</p>
        {!bootstrap.account.canOrganize&&<p className="form-help">After upload, choose Share to create a viewing link. It expires after 7 days. Teams and folders require a workspace account.</p>}
        <label className={`file-picker${file ? " has-file" : ""}`}>
          <Icon name="upload" size={28} /><strong>{file ? file.name : "Choose a video file"}</strong><span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB${duration === null ? " · Reading video…" : ` · ${time(duration)}`}` : "MP4, MOV, or WebM"}</span>
          <input aria-label="Video file" type="file" accept="video/*,.mov,.mp4,.webm" required={!file} disabled={busy || prepared} onChange={event => {
            const chosen = event.currentTarget.files?.[0] || null;
            setFile(chosen); setDuration(null); setFileError(""); setError("");
            setTitle(chosen ? chosen.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ") : "");
            recordingId.current = crypto.randomUUID();
          }} />
        </label>
        {fileError && <Notice error>{fileError}</Notice>}
        <label>Video title<input required maxLength={240} value={title} onChange={event => setTitle(event.target.value)} disabled={busy || prepared} placeholder="Give your recording a name" /></label>
        {bootstrap.account.canOrganize&&<><label>Who can watch<select value={teamId} disabled={busy || prepared} onChange={event => { setTeamId(event.target.value); setFolderId(""); }}><option value="">Only me</option>{bootstrap.teams.map(team => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label>
        <label>Folder<select value={folderId} onChange={event => setFolderId(event.target.value)} disabled={busy || prepared}><option value="">No folder</option>{bootstrap.folders.filter(item => (item.teamId || "") === teamId).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></>}
        {prepared && !busy && <p className="form-help">Retry uses the same recording and details to avoid creating a duplicate.</p>}
        {step && <Notice><span className="spinner" />{step}</Notice>}
        {error && <Notice error>{error}</Notice>}
        <footer className="modal-footer"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || !file || duration === null || !!fileError || !title.trim()}>{busy ? "Uploading…" : prepared ? "Retry upload" : "Upload video"}<Icon name="arrow" size={17} /></button></footer>
      </form>
    </Modal>
  );
}

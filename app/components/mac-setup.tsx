import { useState } from "react";
import { Link } from "react-router";
import type { User } from "../../shared/contracts";
import { Icon } from "./ui";
import "../mac-setup.css";

export function MacSetup({ user, serverOrigin, onUpload }: { user: User; serverOrigin: string; onUpload: () => void }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  async function copyAddress() {
    try { await navigator.clipboard.writeText(serverOrigin); setCopy("copied"); }
    catch { setCopy("failed"); }
  }
  return <section className="mac-setup" aria-labelledby="mac-setup-title">
    <header className="mac-setup-heading"><div><p className="mac-setup-eyebrow">YOUR WORKSPACE, READY WHEN YOU ARE</p><h2 id="mac-setup-title">Welcome, {user.name}.</h2><p>A short recording can move a whole conversation forward.</p></div><span className="mac-availability"><span aria-hidden="true" />Mac download coming soon</span></header>
    <div className="mac-setup-body">
      <div className="mac-setup-intro"><span className="mac-app-icon" aria-hidden="true"><Icon name="video" size={30} /></span><h3>Start with the Mac app.</h3><p>A public installer isn’t available yet. If you already have the app, connect it to this workspace below.</p><div className="mac-server"><span>Your server address</span><code>{serverOrigin}</code><button className="button" type="button" onClick={copyAddress}>{copy === "copied" ? <><Icon name="check" size={15} />Copied</> : "Copy address"}</button><p role="status">{copy === "failed" ? "Couldn’t copy. Select and copy the address above." : copy === "copied" ? "Server address copied." : "Use this address in the Mac app’s Settings."}</p></div></div>
      <ol className="mac-setup-steps">
        <li><span aria-hidden="true">01</span><div><h3>Connect your account</h3><p>Open Settings from the Mac menu bar. Paste your server address, choose Save server, then sign in with this workspace account.</p></div></li>
        <li><span aria-hidden="true">02</span><div><h3>Allow screen recording</h3><p>Allow Screen Recording when macOS asks, or in System Settings under Privacy &amp; Security. Microphone and system audio are optional.</p></div></li>
        <li><span aria-hidden="true">03</span><div><h3>Record something worth showing</h3><p>Choose New recording in the menu bar, pick a Window or Screen, then press Start. Stop the recording to finish and upload it.</p></div></li>
        <li><span aria-hidden="true">04</span><div><h3>Find it in your workspace</h3><p>Your uploaded recording appears in <Link to="/my-videos">My videos</Link>. If an upload fails, open the Mac app’s Settings and retry the saved recording.</p></div></li>
      </ol>
    </div>
    <footer className="mac-setup-footer"><p>Have a video ready to share?</p><button className="button" onClick={onUpload}><Icon name="upload" size={16} />Upload existing video</button></footer>
  </section>;
}

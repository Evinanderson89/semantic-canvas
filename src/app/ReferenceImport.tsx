import { useEffect, useMemo, useRef, useState } from "react";
import type { Model } from "../semantic/model.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import { blueprintSchema, buildReference, initialMapping, type Blueprint, type ReferenceMapping } from "../reference/blueprint.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { readResponse } from "./http.ts";

interface ReferenceFile { name: string; mime: "image/png" | "image/jpeg" | "image/webp" | "application/pdf"; data: string; preview?: string }
async function prepareFile(file: File): Promise<ReferenceFile> {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    if (file.size > 5 * 1024 * 1024) throw new Error("Choose a PDF under 5 MB with up to 6 pages.");
    const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = () => reject(new Error("Could not read this file")); r.readAsDataURL(file); });
    return { name: file.name, mime: "application/pdf", data };
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG, WebP image or PDF. Export HEIC photos as JPEG first.");
  if (file.size > 25 * 1024 * 1024) throw new Error("Choose an image under 25 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL("image/jpeg", 0.9); return { name: file.name, mime: "image/jpeg", data: preview.split(",")[1], preview };
  } finally { bitmap.close(); }
}
export function ReferenceImport({ model, aiAvailable, width, onCreate, onClose, onConnections }: {
  model: Model; aiAvailable: boolean; width: number;
  onCreate: (spec: DashboardSpec, height: number) => void; onClose: () => void; onConnections: () => void;
}) {
  const [file, setFile] = useState<ReferenceFile | null>(null), [blueprint, setBlueprint] = useState<Blueprint | null>(null), [mapping, setMapping] = useState<ReferenceMapping>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [camera, setCamera] = useState(false), [preparing, setPreparing] = useState(false);
  const request = useRef<AbortController | null>(null), stream = useRef<MediaStream | null>(null), video = useRef<HTMLVideoElement>(null), sequence = useRef(0), upload = useRef<HTMLInputElement>(null);
  const stopCamera = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; setCamera(false); };
  useEffect(() => () => { sequence.current++; request.current?.abort(); stream.current?.getTracks().forEach(t => t.stop()); }, []);
  useEffect(() => { if (camera && video.current && stream.current) { video.current.srcObject = stream.current; video.current.play().catch(() => setError("Could not start the camera preview.")); } }, [camera]);
  const choose = async (f?: File) => { if (!f) return; const n = ++sequence.current; stopCamera(); request.current?.abort(); setPreparing(true); setError(""); setBlueprint(null); setFile(null);
    try { const prepared = await prepareFile(f); if (n === sequence.current) setFile(prepared); } catch (e: any) { if (n === sequence.current) setError(e.message); } finally { if (n === sequence.current) setPreparing(false); } };
  const startCamera = async () => { const n = ++sequence.current; setError("");
    try { const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }); if (n !== sequence.current) { s.getTracks().forEach(t => t.stop()); return; } stream.current = s; setCamera(true); }
    catch { if (n === sequence.current) setError("Camera unavailable. Allow camera access in your browser, or upload a photo instead."); } };
  const plan = useMemo(() => blueprint ? buildReference(blueprint, mapping, model, width) : null, [blueprint, mapping, model, width]);
  const unresolved = plan?.notes.filter(n => n.status === "unresolved").length ?? 0;
  const fields = Object.values(model.tables).flatMap(t => t.columns.map(c => `${t.name}.${c.name}`));
  return <StudioDialog title={blueprint ? "Review your reference" : "Recreate from a reference"} wide onClose={onClose}>
    <section className="reference-import"><div className="reference-intro"><span className="eyebrow">From an idea to live data</span><h2>{blueprint ? "Make the right connections." : "Bring the shape of your thinking."}</h2>
      <p className="lede">{blueprint ? "Confirm the catalogue matches below. The new dashboard will query your connected data; unresolved charts remain labelled placeholders." : "Photograph a sketch, or upload a dashboard image or PDF. We’ll recreate its layout with metrics from your semantic catalogue."}</p></div>
      {!blueprint ? <>
        <input ref={upload} type="file" aria-label="Upload dashboard reference" accept="image/png,image/jpeg,image/webp,application/pdf,.pdf" hidden onChange={e => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        {camera ? <div className="reference-camera"><video ref={video} autoPlay playsInline muted /><div><button className="primary" onClick={() => {
          const v = video.current; if (!v?.videoWidth) return; const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d")!.drawImage(v, 0, 0);
          c.toBlob(b => { if (b) choose(new File([b], "Sketch photo.jpg", { type: "image/jpeg" })); }, "image/jpeg", 0.9);
        }}>Use this photo</button><button className="link" onClick={() => { sequence.current++; stopCamera(); }}>Cancel camera</button></div></div> :
        <div className="reference-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) choose(e.dataTransfer.files[0]); }}>
          {file?.preview ? <img src={file.preview} alt="Dashboard reference" /> : <div className="reference-glyph" aria-hidden="true">▧</div>}
          <b>{preparing ? "Preparing your reference…" : file?.name ?? "A rough sketch is a great start."}</b><span>PNG, JPEG, WebP · PDF up to 6 pages / 5 MB</span>
          <div><button disabled={busy || preparing} className="primary" onClick={() => upload.current?.click()}>{file ? "Choose another file" : "Upload a reference"}</button><button disabled={busy || preparing} className="link" onClick={startCamera}>Take a photo</button></div>
        </div>}
        <p className="muted">When you choose Read reference, the file and catalogue metadata are sent to your configured AI provider. The original file is not saved in the dashboard. Reading quality depends on the image and model.</p>
        {!aiAvailable && <p className="reference-connection">Connect an AI provider to read images and PDFs. <button className="link" onClick={onConnections}>Open Connections</button></p>}
      </> : <>
        <div className="reference-summary"><b>{blueprint.pages.length} {blueprint.pages.length === 1 ? "tab" : "tabs"}</b><span>{(plan?.notes.length ?? 0) - unresolved} matched</span><span>{unresolved} to resolve</span></div>
        {blueprint.pages.map((page, pi) => <div className="reference-page" key={pi}><h3>{page.title}</h3><div className="reference-mini" style={{ aspectRatio: Math.max(0.6, page.aspectRatio) }} aria-label={`Layout preview: ${page.title}`}>
          {page.items.map(item => <div key={item.id} className={`reference-block ${item.kind} ${plan?.notes.find(n => n.id === item.id)?.status ?? ""}`} style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${Math.min(item.w, 1 - item.x) * 100}%`, height: `${Math.min(item.h, 1 - item.y) * 100}%` }}>{item.label}</div>)}
        </div>{page.items.filter(i => i.kind === "metric" || i.kind === "filter").map(item => <div className="reference-match" key={item.id}><div><b>{item.label}</b><small className={plan?.notes.find(n => n.id === item.id)?.status}>{plan?.notes.find(n => n.id === item.id)?.message}</small></div>
          {item.metrics.map((m, i) => <label className="form-field" key={`m${i}`}>Metric: {m}<select aria-label={`Match ${m}`} value={mapping[`${item.id}:m${i}`] ?? ""} onChange={e => setMapping({ ...mapping, [`${item.id}:m${i}`]: e.target.value })}><option value="">Keep as a placeholder</option>{Object.values(model.metrics).map(m => <option key={m.name} value={m.name}>{m.label} · {m.name}</option>)}</select></label>)}
          {item.dimensions.map((d, i) => <label className="form-field" key={`d${i}`}>Field: {d}<select aria-label={`Match field ${d}`} value={mapping[`${item.id}:d${i}`] ?? ""} onChange={e => setMapping({ ...mapping, [`${item.id}:d${i}`]: e.target.value })}><option value="">Choose a catalogue field…</option>{fields.map(f => <option key={f}>{f}</option>)}</select></label>)}
          {item.kind === "metric" && item.dimensions.length > 0 && <label className="form-field">Time grouping<select aria-label={`Time grouping for ${item.label}`} value={item.grain} onChange={e => setBlueprint({ ...blueprint, pages: blueprint.pages.map(p => ({ ...p, items: p.items.map(x => x.id === item.id ? { ...x, grain: e.target.value as typeof x.grain } : x) })) })}>{["none", "day", "week", "month", "quarter", "year"].map(g => <option key={g}>{g}</option>)}</select></label>}
        </div>)}</div>)}
        <p className="muted">This is an editable reconstruction. Chart sizes may expand for readability. Use Design review and Smart arrange to refine the result.</p>
      </>}{error && <p role="alert">{error}</p>}
    </section><footer>{blueprint && <button className="link" onClick={() => setBlueprint(null)}>Back to reference</button>}<span className="spacer" />
      {blueprint && plan ? <button className="primary" onClick={() => onCreate(plan.spec, plan.height)}>{unresolved ? `Create with ${unresolved} placeholders` : "Create dashboard"}</button> : <button className="primary" disabled={!file || !aiAvailable || busy || preparing || camera} onClick={async () => {
        if (!file) return; setBusy(true); setError(""); request.current?.abort(); const ac = new AbortController(); request.current = ac;
        try { const data = await fetch("/api/reference/analyze", { method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal, body: JSON.stringify({ mime: file.mime, data: file.data }) }).then(readResponse);
          const b = blueprintSchema.parse(data.blueprint); if (!ac.signal.aborted) { setMapping(initialMapping(b, model)); setBlueprint(b); }
        } catch (e: any) { if (!ac.signal.aborted) setError(e.message); } finally { if (!ac.signal.aborted) setBusy(false); }
      }}>{busy ? "Reading layout and labels…" : "Read reference"}</button>}
    </footer>
  </StudioDialog>;
}

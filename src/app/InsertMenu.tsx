import { useState } from "react";
import type { Model } from "../semantic/model.ts";
import { metricsByTable } from "../semantic/model.ts";
import type { TileSpec } from "../compiler/spec.ts";
import { prettyTable } from "./Sidebar.tsx";
import { pickImage } from "./imagePicker.ts";

type Draft = Omit<TileSpec, "id" | "layout">;

/**
 * A floating insert palette. Kept on the canvas rather than in the top bar
 * because adding things is the most frequent action while composing, and it
 * should be reachable without moving your eye off the work.
 */
export function InsertMenu({ model, onInsert, onInsertMany, onOpenPicker, onFilter }: {
  model: Model;
  onInsert: (d: Draft, size?: { w: number; h: number }) => void;
  onInsertMany: (d: Draft[], layout: "row") => void;
  onOpenPicker: () => void;
  onFilter: () => void;
}) {
  const [open, setOpen] = useState<null | "views" | "elements">(null);
  const byTable = metricsByTable(model);
  const tables = Object.entries(byTable).sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="insert">
      {open === "views" && (
        <div className="pop">
          <h5>Pre-composed views</h5>
          <p className="pop-hint">Drops a whole block, laid out and ready.</p>
          {tables.slice(0, 6).map(([name, ms]) => (
            <button key={name} className="pop-item" onClick={() => {
              onInsertMany(ms.slice(0, 4).map((m) => ({
                kind: "metric", title: m.label, metrics: [m.name],
                dimensions: [], chart: "kpi",
              })), "row");
              setOpen(null);
            }}>
              <b>{prettyTable(name)} KPI row</b>
              <small>{ms.slice(0, 4).map((m) => m.label).join(" · ')".replace(")'", ""))}</small>
            </button>
          ))}
        </div>
      )}

      {open === "elements" && (
        <div className="pop">
          <h5>Elements</h5>
          <button className="pop-item" onClick={() => {
            onInsert({ kind: "heading", text: "Section heading", metrics: [], dimensions: [] },
                     { w: 420, h: 56 }); setOpen(null); }}>
            <b>Heading</b><small>A section title</small>
          </button>
          <button className="pop-item" onClick={() => {
            onInsert({ kind: "text", text: "Add a note explaining what this section shows.",
                       metrics: [], dimensions: [] }, { w: 420, h: 120 }); setOpen(null); }}>
            <b>Text note</b><small>Commentary beside the numbers</small>
          </button>
          <button className="pop-item" onClick={() => {
            onInsert({ kind: "divider", metrics: [], dimensions: [] }, { w: 720, h: 24 });
            setOpen(null); }}>
            <b>Divider</b><small>A rule between sections</small>
          </button>
          <button className="pop-item" onClick={() => {
            setOpen(null);
            pickImage((data) => onInsert({ kind: "image", metrics: [], dimensions: [], imageData: data },
                                          { w: 360, h: 240 }));
          }}>
            <b>Image</b><small>A picture, logo or screenshot</small>
          </button>
        </div>
      )}

      <div className="insert-bar">
        <button className="ins primary" onClick={() => { setOpen(null); onOpenPicker(); }}>
          <Plus /> Tile
        </button>
        <button className={"ins" + (open === "views" ? " on" : "")}
                onClick={() => setOpen(open === "views" ? null : "views")}>
          Views
        </button>
        <button className="ins" onClick={() => { setOpen(null); onFilter(); }}>Filter</button>
        <button className={"ins" + (open === "elements" ? " on" : "")}
                onClick={() => setOpen(open === "elements" ? null : "elements")}>
          Text
        </button>
      </div>
    </div>
  );
}

const Plus = () => (
  <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10 4v12M4 10h12" />
  </svg>
);

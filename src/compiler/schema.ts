import { z } from "zod";
import { DEFAULT_CANVAS } from "../canvas/presets.ts";

// The browser, HTTP API and agent tools share the same document contract.
export const DOCUMENT_VERSION = 1;
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const name = z.string().min(1).max(256);
const finite = z.number().finite();
const value = z.union([z.string().max(10000), finite, z.boolean(), z.null()]);
export const filterSchema = z.object({
  id: name, field: name, source: z.enum(["dimension", "metric"]),
  mode: z.enum(["discrete", "range"]), values: z.array(value).max(1000).optional(),
  min: z.union([finite, z.string().max(256), z.null()]).optional(),
  max: z.union([finite, z.string().max(256), z.null()]).optional(), exclude: z.boolean().optional(), maxExclusive: z.boolean().optional(),
}).strict();
const formatSchema = z.object({
  number: z.enum(["auto", "currency", "percent", "compact", "plain"]),
  decimals: finite.int().min(0).max(20).nullable(),
  xTitle: z.string().max(1000).nullable(), yTitle: z.string().max(1000).nullable(),
  showX: z.boolean(), showY: z.boolean(), grid: z.boolean(), legend: z.enum(["auto", "hide"]),
  palette: name, padding: finite.min(0).max(200), background: z.boolean(), border: z.boolean(),
  backgroundColor: z.string().max(128).nullable(), backgroundOpacity: finite.min(0).max(100),
  textSize: z.preprocess((v) => typeof v === "string" ? ({ s: 13, m: 19, l: 26, xl: 34 }[v]) : v,
    finite.min(1).max(500)), textAlign: z.enum(["left", "center", "right"]),
  fontFamily: z.enum(["sans", "serif", "mono", "arial", "times", "courier", "verdana", "trebuchet", "palatino", "impact"]),
  textItalic: z.boolean(), textUnderline: z.boolean(), imageFit: z.enum(["contain", "cover"]),
}).partial().strict();
export const querySchema = z.object({
  id: name.optional(), metrics: z.array(name).min(1).max(50),
  dimensions: z.array(name).max(12).default([]), where: z.array(filterSchema).max(100).optional(),
  limit: finite.int().min(1).max(5000).optional(), compare: z.enum(["none", "prior", "yoy"]).optional(),
}).strict();
export const tileSchema = querySchema.extend({
  id: name, metrics: z.array(name).max(50), section: name.optional(), pinned: z.boolean().optional(),
  tabId: name.optional(), filterId: name.optional(),
  kind: z.enum(["metric", "heading", "text", "divider", "image", "filter"]).optional(),
  title: z.string().max(1000).optional(), text: z.string().max(100000).optional(),
  imageData: z.string().max(6 * 1024 * 1024).regex(/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/).optional(),
  chart: z.enum(["line", "area", "areaStacked", "bar", "barGrouped", "barStacked", "barH", "barHorizontal", "scatter", "heatmap", "map", "donut", "waterfall", "funnel", "smallMultiples", "combo", "stat", "kpi", "table"]).optional(),
  compareShow: z.enum(["value", "delta", "percent"]).optional(), format: formatSchema.optional(),
  spark: z.object({ shape: z.enum(["line", "area", "bar"]), scale: z.enum(["fit", "zero"]),
    compare: z.enum(["prior", "first"]), color: z.enum(["auto", "accent", "neutral"]),
    showRange: z.boolean(), showMinMax: z.boolean() }).partial().strict().optional(),
  layout: z.object({ x: finite.min(0).max(100000), y: finite.min(0).max(100000),
    w: finite.positive().max(100000), h: finite.positive().max(100000), z: finite.int().optional() }).strict(),
}).refine((t) => t.kind && t.kind !== "metric" || t.metrics.length > 0, "Metric tiles need a metric");
export const filterValueSchema = z.object({ values: z.array(value).max(1000).optional(),
  min: z.union([finite, z.string().max(256), z.null()]).optional(), max: z.union([finite, z.string().max(256), z.null()]).optional(),
}).strict();
export const dashboardFilterSchema = z.object({
  id: name, label: z.string().min(1).max(100), field: name, control: z.enum(["select", "date", "number"]),
  scope: z.enum(["tab", "report"]), tabId: name.optional(),
  bindings: z.array(z.object({ tileId: name, field: name }).strict()).max(500),
  defaultValue: filterValueSchema.optional(),
}).strict();
export const dashboardSchema = z.object({
  title: z.string().min(1).max(1000), description: z.string().max(100000).optional(),
  tiles: z.array(tileSchema).max(500), crossFilters: z.array(filterSchema).max(100).optional(),
  tabs: z.array(z.object({ id: name, title: z.string().min(1).max(100) }).strict()).min(1).max(20).optional(),
  filters: z.array(dashboardFilterSchema).max(64).optional(),
}).strict().refine((d) => new Set(d.tiles.map((t) => t.id)).size === d.tiles.length, "Tile IDs must be unique");
export const canvasSchema = z.object({
  preset: name, width: finite.min(100).max(100000), height: finite.min(100).max(100000),
  snap: z.boolean(), grid: finite.positive().max(1000), locked: z.boolean(),
  background: z.string().max(128).optional(),
}).strict();
export const saveSchema = z.object({
  id: name, name: z.string().max(1000).optional(), spec: dashboardSchema,
  canvas: canvasSchema.default(DEFAULT_CANVAS),
  schemaVersion: z.literal(DOCUMENT_VERSION).default(DOCUMENT_VERSION),
  revision: finite.int().nonnegative().default(0),
}).strict();

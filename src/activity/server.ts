import { createHash, randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import { z } from "zod";
import { alertInputSchema, commentInputSchema, type ActivityRecord, type AlertInput, type AlertRule, type CommentThread, type Evaluation } from "./model.ts";
import { evaluateAlert } from "./evaluate.ts";
import { dueAlerts, listActivity, loadDashboard, mutateActivity, StoreConflict } from "../store/store.ts";
import { identityOf, canUseSource, type CompanyAuth, type GatewayPolicyRule } from "../security/auth.ts";
import type { Principal, RlsConfig } from "../security/rls.ts";
import { requireScope } from "../security/queryScope.ts";
import type { Source } from "../sources/registry.ts";
import { filtersForTile } from "../app/filters.ts";
import { visibleQuery } from "../app/query.ts";
import { compileTile, splitPartialPeriods, validateTile } from "../compiler/compile.ts";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const versionSchema = z.number().int().nonnegative();
export function mountChartActivity(app: Express, deps: {
  safe: (fn: (req: any, res: any) => any) => any; auth: CompanyAuth;
  source: (req: Request) => Source; sources: () => Source[];
  principal: (req: Request) => Principal | null; rls: () => RlsConfig;
}) {
  const audience = (who: Principal | null) => hash({ principal: who, policies: deps.rls().policies });
  const owner = (req: Request) => identityOf(req)?.id ?? `local:${deps.principal(req)?.id ?? "anonymous"}`;
  const author = (req: Request) => ({ authorId: owner(req), authorName: identityOf(req)?.name ?? deps.principal(req)?.name ?? "Local user" });
  async function context(req: Request, needsTile = true) {
    const source = deps.source(req), who = deps.principal(req);
    const dashboardId = String(req.params.dashboardId);
    const document = await loadDashboard(dashboardId, { source: source.id, model: source.model!.name });
    if (!document) throw failure("Dashboard not found in this source", 404);
    const tileId = String(req.params.tileId ?? ""), tile = document.spec.tiles.find(t => t.id === tileId);
    if (needsTile && (!tile || tile.kind && tile.kind !== "metric")) throw failure("Save this chart before adding comments or alerts", 404);
    if (tile) requireScope(source.model!, source.model!.metrics[tile.metrics[0]]?.baseTable, deps.rls(), who, identityOf(req)?.policy);
    return { source, who, document, tile: tile!, scope: { source: source.id, dashboardId, audience: audience(who) }, ownerId: owner(req) };
  }
  // A watch is evaluated later with no request, so it cannot carry the gateway's per-request data policy. Rather than
  // evaluate it unscoped, creating one is refused while a gateway policy applies to the chart's table.
  function chartQuery(source: Source, document: DashboardSpec, tile: TileSpec, rule: AlertInput, who: Principal | null, policy: GatewayPolicyRule[] = []) {
    if (!tile.metrics.includes(rule.metric)) throw failure("Choose a metric from this saved chart");
    if (tile.dimensions.length > 1 || tile.dimensions.length === 1 && !tile.dimensions[0].includes(":")) throw failure("Alerts need a total or a time series with no category breakdown");
    if (rule.mode === "anomaly" && tile.dimensions.length !== 1) throw failure("Anomaly checks need a time-series chart");
    const defaults = Object.fromEntries((document.filters ?? []).map(f => [f.id, f.defaultValue ?? {}]));
    const query = { ...visibleQuery(source.model!, { ...tile, metrics: [rule.metric] }, [...(document.crossFilters ?? []), ...filtersForTile(document, tile, defaults)]), compare: "none" as const, limit: 1000, layout: tile.layout };
    const issues = validateTile(source.model!, query);
    if (issues.length) throw failure("The saved chart needs valid semantic fields before it can be watched");
    const scoped = requireScope(source.model!, source.model!.metrics[rule.metric].baseTable, deps.rls(), who, policy);
    if (scoped.filters.some((f) => f.id.startsWith("gateway:"))) throw failure("A data policy set at the gateway applies to this chart. Watches run in the background without your session, so they cannot carry it yet; ask an administrator.", 403);
    return { ...query, where: [...(query.where ?? []), ...scoped.filters] };
  }
  const fingerprint = (query: ReturnType<typeof chartQuery>, source: Source) => hash({ query: { metrics: query.metrics, dimensions: query.dimensions, where: query.where }, model: source.model });
  async function evaluate(source: Source, query: ReturnType<typeof chartQuery>, rule: AlertInput, who: Principal | null) {
    const sql = compileTile(source.model!, source.conn!, query, { probe: true });
    const raw = await source.conn!.execute(sql, 1001, `alert:${who?.id ?? "anon"}:${randomUUID()}`);
    const result = splitPartialPeriods(raw);
    return evaluateAlert(rule, result, query.dimensions[0]);
  }
  const base = "/api/chart-activity/:dashboardId";
  app.get(base, deps.safe(async (req, res) => {
    const ctx = await context(req, false), rows = await listActivity(ctx.scope, ctx.ownerId);
    const summary: Record<string, any> = {};
    for (const row of rows) {
      if (!ctx.document.spec.tiles.some(t => t.id === row.tileId)) continue;
      const entry = summary[row.tileId] ??= { comments: 0 };
      if (row.type === "thread" && !(row.body as CommentThread).resolved) entry.comments++;
      if (row.type === "alert") { const r = row.body as AlertRule; entry.alert = { enabled: r.enabled, state: r.evaluation?.state, unread: r.events.filter(e => !e.read).length }; }
    }
    res.json({ summary });
  }));
  app.get(base + "/:tileId", deps.safe(async (req, res) => {
    const ctx = await context(req), rows = (await listActivity(ctx.scope, ctx.ownerId)).filter(r => r.tileId === ctx.tile.id);
    res.json({ threads: rows.filter(r => r.type === "thread").map(r => r.body).sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt)),
      alert: rows.find(r => r.type === "alert")?.body ?? null, ownerId: ctx.ownerId });
  }));
  app.post(base + "/:tileId/comments", deps.safe(async (req, res) => {
    const ctx = await context(req), { body } = commentInputSchema.parse(req.body), id = randomUUID();
    const row: ActivityRecord = { ...ctx.scope, id, tileId: ctx.tile.id, type: "thread", ownerId: ctx.ownerId,
      body: { id, ...author(req), body, createdAt: new Date().toISOString(), resolved: false, replies: [] } };
    await mutateActivity(ctx.scope, ctx.tile.id, () => row); res.status(201).json({ ok: true });
  }));
  app.post(base + "/:tileId/comments/:commentId/replies", deps.safe(async (req, res) => {
    const ctx = await context(req), { body } = commentInputSchema.parse(req.body);
    await mutateActivity(ctx.scope, ctx.tile.id, rows => {
      const row = rows.find(r => r.id === req.params.commentId && r.type === "thread"); if (!row) throw failure("Comment not found", 404);
      const thread = row.body as CommentThread;
      if (thread.resolved) throw failure("Reopen this conversation before replying", 409);
      if (thread.replies.length >= 100) throw failure("Start a new conversation; this thread has reached 100 replies", 409);
      thread.replies.push({ id: randomUUID(), ...author(req), body, createdAt: new Date().toISOString() }); return row;
    }); res.json({ ok: true });
  }));
  app.patch(base + "/:tileId/comments/:commentId", deps.safe(async (req, res) => {
    const ctx = await context(req), { resolved } = z.object({ resolved: z.boolean() }).strict().parse(req.body);
    await mutateActivity(ctx.scope, ctx.tile.id, rows => {
      const row = rows.find(r => r.id === req.params.commentId && r.type === "thread"); if (!row) throw failure("Comment not found", 404);
      if (row.ownerId !== ctx.ownerId && identityOf(req)?.role === "viewer") throw failure("Only the author or an editor can resolve this conversation", 403);
      (row.body as CommentThread).resolved = resolved; return row;
    }); res.json({ ok: true });
  }));
  app.post(base + "/:tileId/alerts/preview", deps.safe(async (req, res) => {
    const ctx = await context(req), input = z.object({ rule: alertInputSchema, revision: versionSchema }).strict().parse(req.body);
    if (input.revision !== ctx.document.revision) throw new StoreConflict("Save or reopen the latest dashboard before testing an alert");
    const query = chartQuery(ctx.source, ctx.document.spec, ctx.tile, input.rule, ctx.who, identityOf(req)?.policy);
    res.json({ evaluation: await evaluate(ctx.source, query, input.rule, ctx.who) });
  }));
  app.put(base + "/:tileId/alert", deps.safe(async (req, res) => {
    const ctx = await context(req), input = z.object({ rule: alertInputSchema, revision: versionSchema, version: versionSchema }).strict().parse(req.body);
    if (input.revision !== ctx.document.revision) throw new StoreConflict("Save or reopen the latest dashboard before creating an alert");
    const query = chartQuery(ctx.source, ctx.document.spec, ctx.tile, input.rule, ctx.who, identityOf(req)?.policy);
    await mutateActivity(ctx.scope, ctx.tile.id, rows => {
      const current = rows.find(r => r.type === "alert" && r.ownerId === ctx.ownerId), old = current?.body as AlertRule | undefined;
      if ((old?.version ?? 0) !== input.version) throw new StoreConflict("This alert changed. Close and reopen it before editing");
      const id = old?.id ?? randomUUID(), now = new Date().toISOString();
      return { ...ctx.scope, id, tileId: ctx.tile.id, type: "alert", ownerId: ctx.ownerId,
        body: { ...input.rule, id, version: input.version + 1, enabled: old?.enabled ?? true, ownerId: ctx.ownerId, principalId: ctx.who?.id ?? "", queryFingerprint: fingerprint(query, ctx.source), nextCheckAt: now, createdAt: old?.createdAt ?? now, events: old?.events ?? [] } };
    }); res.json({ ok: true });
  }));
  app.patch(base + "/:tileId/alert", deps.safe(async (req, res) => {
    const ctx = await context(req), input = z.object({ enabled: z.boolean().optional(), read: z.literal(true).optional(), version: versionSchema }).strict().parse(req.body);
    await mutateActivity(ctx.scope, ctx.tile.id, rows => {
      const row = rows.find(r => r.type === "alert" && r.ownerId === ctx.ownerId); if (!row) throw failure("Alert not found", 404);
      const rule = row.body as AlertRule;
      if (rule.version !== input.version) throw new StoreConflict("This alert changed. Reopen it before editing");
      if (input.enabled !== undefined) { rule.enabled = input.enabled; rule.version++; rule.nextCheckAt = new Date().toISOString(); }
      if (input.read) rule.events.forEach(e => e.read = true);
      return row;
    }); res.json({ ok: true });
  }));
  app.delete(base + "/:tileId/alert", deps.safe(async (req, res) => {
    const ctx = await context(req), input = z.object({ version: versionSchema }).strict().parse(req.body);
    await mutateActivity(ctx.scope, ctx.tile.id, rows => {
      const row = rows.find(r => r.type === "alert" && r.ownerId === ctx.ownerId); if (!row) throw failure("Alert not found", 404);
      if ((row.body as AlertRule).version !== input.version) throw new StoreConflict("This alert changed. Reopen it before deleting");
      return { deleteId: row.id };
    }); res.json({ ok: true });
  }));

  const inFlight = new Map<string, Promise<void>>();
  async function check(row: ActivityRecord) {
    if (inFlight.has(row.id)) return inFlight.get(row.id);
    const work = (async () => {
      const rule = row.body as AlertRule, checkedAt = new Date().toISOString();
      let evaluation: Evaluation;
      try {
        const source = deps.sources().find(s => s.id === row.source && s.status === "ready");
        const who = deps.rls().principals[rule.principalId] ?? null;
        // Company modes: the owner must still hold access (team session, or a Gateway token verified since start) and the source under the current access policy.
        const identity = deps.auth.currentIdentity(row.ownerId);
        if (deps.auth.config.mode !== "local" && (!identity || identity.principal !== rule.principalId || !canUseSource(identity, row.source))) evaluation = { state: "waiting", reason: "Sign in to resume checks with your current data permissions.", checkedAt };
        else if (audience(who) !== row.audience) evaluation = { state: "needs_review", reason: "Data permissions changed. Recreate this alert with your current access.", checkedAt };
        else if (!source) evaluation = { state: "error", reason: "The data source is unavailable. No alert was inferred.", checkedAt };
        else {
          const document = await loadDashboard(row.dashboardId, { source: row.source, model: source.model!.name });
          const tile = document?.spec.tiles.find(t => t.id === row.tileId);
          if (!document || !tile) return;
          const query = chartQuery(source, document.spec, tile, rule, who);
          evaluation = fingerprint(query, source) !== rule.queryFingerprint
            ? { state: "needs_review", reason: "The saved metric, filters, or semantic model changed. Review and update this alert.", checkedAt }
            : await evaluate(source, query, rule, who);
        }
      } catch { evaluation = { state: "error", reason: "The check could not finish. Check the source connection and saved metric, then try again.", checkedAt }; }
      await mutateActivity(row, row.tileId, (rows, document) => {
        const current = rows.find(r => r.id === row.id); if (!current) return null;
        const latest = current.body as AlertRule;
        if (latest.version !== rule.version || !latest.enabled) return null;
        // A slow query must not post an observation for a chart edited while it ran.
        if (evaluation.state === "triggered" || evaluation.state === "normal") {
          const source = deps.sources().find(s => s.id === row.source && s.status === "ready");
          const who = deps.rls().principals[rule.principalId] ?? null;
          const tile = document.tiles.find(t => t.id === row.tileId);
          try {
            if (!source || !tile || audience(who) !== row.audience || fingerprint(chartQuery(source, document, tile, rule, who), source) !== latest.queryFingerprint)
              evaluation = { state: "needs_review", reason: "The saved chart or data permissions changed during this check. Review your watch.", checkedAt };
          } catch { evaluation = { state: "needs_review", reason: "The saved chart changed during this check. Review your watch.", checkedAt }; }
        }
        const key = evaluation.period ?? "Current total";
        if (evaluation.state === "triggered") {
          if (latest.breachKey !== key) latest.events = [{ ...evaluation, id: randomUUID(), read: false }, ...latest.events].slice(0, 30);
          latest.breachKey = key;
        } else if (evaluation.state === "normal") latest.breachKey = undefined;
        latest.evaluation = evaluation;
        latest.nextCheckAt = new Date(Date.now() + latest.intervalMinutes * 60_000).toISOString();
        return current;
      });
    })().finally(() => inFlight.delete(row.id));
    inFlight.set(row.id, work); return work;
  }
  app.post(base + "/:tileId/alerts/check", deps.safe(async (req, res) => {
    const ctx = await context(req), row = (await listActivity(ctx.scope, ctx.ownerId)).find(r => r.tileId === ctx.tile.id && r.type === "alert");
    if (!row) throw failure("Create an alert first", 404);
    if (!(row.body as AlertRule).enabled) throw failure("Resume this alert before checking it");
    await check(row); res.json({ ok: true });
  }));
  let timer: ReturnType<typeof setInterval> | undefined, stopped = false, sweep: Promise<void> | undefined;
  const tick = () => {
    if (stopped || sweep) return;
    sweep = (async () => { for (const row of (await dueAlerts(new Date().toISOString())).slice(0, 100)) { if (stopped) break; await check(row).catch(() => {}); } })().catch(() => {}).finally(() => { sweep = undefined; });
  };
  return { start() { tick(); timer = setInterval(tick, 60_000); timer.unref(); }, async stop() { stopped = true; clearInterval(timer); await sweep; await Promise.allSettled(inFlight.values()); } };
}

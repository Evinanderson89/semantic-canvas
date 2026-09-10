import { z } from "zod";

export const alertInputSchema = z.object({
  metric: z.string().min(1).max(256), mode: z.enum(["threshold", "anomaly"]),
  operator: z.enum(["above", "below"]).default("above"), threshold: z.number().finite().optional(),
  sensitivity: z.enum(["sensitive", "balanced", "conservative"]).default("balanced"),
  direction: z.enum(["both", "above", "below"]).default("both"),
  intervalMinutes: z.union([z.literal(15), z.literal(60), z.literal(1440)]).default(60),
}).strict().refine(v => v.mode !== "threshold" || v.threshold !== undefined, "Enter a threshold value");
export type AlertInput = z.infer<typeof alertInputSchema>;
export interface Evaluation {
  state: "normal" | "triggered" | "waiting" | "error" | "needs_review";
  reason: string; checkedAt: string; value?: number; period?: string;
  expected?: number; lower?: number; upper?: number; baselinePoints?: number; seasonal?: boolean;
}
export interface AlertRule extends AlertInput {
  id: string; version: number; enabled: boolean; ownerId: string; principalId: string;
  queryFingerprint: string; breachKey?: string; nextCheckAt: string; createdAt: string;
  evaluation?: Evaluation; events: (Evaluation & { id: string; read: boolean })[];
}
export interface Reply { id: string; authorId: string; authorName: string; body: string; createdAt: string }
export interface CommentThread extends Reply { resolved: boolean; replies: Reply[] }
export interface ActivityScope { source: string; dashboardId: string; audience: string }
export interface ActivityRecord {
  id: string; type: "thread" | "alert"; source: string; dashboardId: string; tileId: string;
  audience: string; ownerId: string; body: CommentThread | AlertRule;
}
export interface ActivitySummary { [tileId: string]: { comments: number; alert?: { enabled: boolean; state?: Evaluation["state"]; unread: number } } }

const text = z.string().trim().min(1).max(4000), id = z.string().min(1).max(256), date = z.string().datetime();
export const commentInputSchema = z.object({ body: text }).strict();
const replySchema = z.object({ id, authorId: id, authorName: z.string().max(150), body: text, createdAt: date }).strict();
export const threadSchema = replySchema.extend({ resolved: z.boolean(), replies: z.array(replySchema).max(100) });
export const evaluationSchema = z.object({ state: z.enum(["normal", "triggered", "waiting", "error", "needs_review"]), reason: z.string().max(2000), checkedAt: date,
  value: z.number().finite().optional(), period: z.string().max(100).optional(), expected: z.number().finite().optional(), lower: z.number().finite().optional(), upper: z.number().finite().optional(), baselinePoints: z.number().int().optional(), seasonal: z.boolean().optional(),
}).strict();
export const alertRuleSchema = alertInputSchema.safeExtend({ id, version: z.number().int().positive(), enabled: z.boolean(), ownerId: id, principalId: z.string().max(256), queryFingerprint: id,
  breachKey: z.string().max(100).optional(), nextCheckAt: date, createdAt: date, evaluation: evaluationSchema.optional(), events: z.array(evaluationSchema.extend({ id, read: z.boolean() })).max(30),
});
export const activityRecordSchema = z.object({ id, type: z.enum(["thread", "alert"]), source: id, dashboardId: id, tileId: id, audience: id, ownerId: id, body: z.union([threadSchema, alertRuleSchema]) }).strict()
  .refine(r => r.id === r.body.id && (r.type === "alert" ? alertRuleSchema.safeParse(r.body).success && r.ownerId === (r.body as AlertRule).ownerId : threadSchema.safeParse(r.body).success && r.ownerId === (r.body as CommentThread).authorId), "Activity ownership or type is inconsistent");

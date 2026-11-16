/** Keep provider internals out of the reading flow; offer an actionable recovery. */
export function aiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/credit balance|insufficient_quota|billing|insufficient.*credit/i.test(raw)) return "Your AI provider has no available credits. Check billing in your provider account, then retry. Your dashboard is unchanged.";
  if (/401|403|api.key|authentication|unauthorized/i.test(raw)) return "The AI provider could not authenticate. Check the AI connection in Connections, then retry. Your dashboard is unchanged.";
  if (/429|rate.limit|overloaded|503/i.test(raw)) return "The AI provider is temporarily unavailable or busy. Wait a moment and retry. Your dashboard is unchanged.";
  if (/timeout|timed out|fetch failed|network/i.test(raw)) return "The AI request could not finish. Check the connection and retry. Your dashboard is unchanged.";
  return /request_id|invalid_request_error|\{"/.test(raw) ? "The AI provider rejected this request. Check the connection in Connections and retry. Your dashboard is unchanged." : raw || "AI could not finish. Please retry.";
}

export interface AlertWebhookPayload {
  dashboardId: string;
  dashboardTitle: string;
  tileId: string;
  tileTitle: string;
  metric: string;
  summary: string;
  checkedAt: string;
}

export interface AlertWebhookResult {
  sent: boolean;
  status?: number;
  error?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function validateWebhookUrl(rawUrl: string): URL | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { error: "Invalid webhook URL" };
  }
  if (parsed.username || parsed.password) {
    return { error: "Webhook URL must not include credentials" };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    return { error: "Webhook URL host is not allowed" };
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(host)) {
    return parsed;
  }
  return { error: "Webhook URL must use HTTPS (or http://127.0.0.1 / http://localhost for local testing)" };
}

export async function sendAlertWebhook(
  webhookUrl: string | undefined,
  payload: AlertWebhookPayload,
): Promise<AlertWebhookResult> {
  const trimmed = webhookUrl?.trim();
  if (!trimmed) return { sent: false };

  const validated = validateWebhookUrl(trimmed);
  if ("error" in validated) {
    return { sent: false, error: validated.error };
  }

  const body = {
    event: "alert.triggered" as const,
    dashboardId: payload.dashboardId,
    dashboardTitle: payload.dashboardTitle,
    tileId: payload.tileId,
    tileTitle: payload.tileTitle,
    metric: payload.metric,
    summary: payload.summary,
    checkedAt: payload.checkedAt,
    text: `*[Semantic Canvas Alert]* ${payload.tileTitle} (${payload.metric}): ${payload.summary}`,
  };

  try {
    const res = await fetch(validated.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { sent: false, status: res.status, error: `Webhook returned HTTP ${res.status}` };
    }
    return { sent: true, status: res.status };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

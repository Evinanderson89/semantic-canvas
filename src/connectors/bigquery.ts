import { importPKCS8, SignJWT } from "jose";
import type { CatalogTable, Connector, ExecutionOptions, QueryResult } from "./types.ts";
import { executionBudget } from "./execution.ts";

export interface BigQueryOptions {
  projectId: string;
  dataset: string;
  location?: string;
  /** Google Service Account JSON (stringified JSON or parsed object with client_email & private_key). */
  credentialsJson?: string;
  clientEmail?: string;
  privateKey?: string;
  /** Pre-minted bearer token (useful for Workload Identity / tests). */
  accessToken?: string;
  /** Injectable fetch for deterministic unit tests. */
  fetchImpl?: typeof fetch;
}

const BQ_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";
const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";

function coerceBigQueryCell(raw: unknown, fieldType: string): unknown {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  const t = fieldType.toUpperCase();
  if (t === "BOOLEAN" || t === "BOOL") return s === "true";
  if (t === "INTEGER" || t === "INT64") {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (t === "FLOAT" || t === "FLOAT64" || t === "NUMERIC" || t === "BIGNUMERIC") {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (t === "TIMESTAMP") {
    const secs = Number(s);
    if (Number.isFinite(secs)) return new Date(secs * 1000).toISOString();
    return s;
  }
  return s;
}

function parseServiceAccount(opts: BigQueryOptions): { clientEmail: string; privateKey: string } | null {
  if (opts.clientEmail && opts.privateKey) {
    return {
      clientEmail: opts.clientEmail,
      privateKey: opts.privateKey.replace(/\\n/g, "\n"),
    };
  }
  if (opts.credentialsJson) {
    const parsed = JSON.parse(opts.credentialsJson) as { client_email?: string; private_key?: string };
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("BigQuery service account JSON must include client_email and private_key");
    }
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key.replace(/\\n/g, "\n"),
    };
  }
  return null;
}

/**
 * Google BigQuery connector via REST API v2 + RS256 Service Account JWT (using `jose`).
 * Zero heavy native SDK dependencies; read-only OAuth scope enforced at token minting.
 */
export async function bigqueryConnector(opts: BigQueryOptions): Promise<Connector> {
  const projectId = opts.projectId.trim();
  const dataset = opts.dataset.trim();
  if (!projectId || !dataset) {
    throw new Error("BigQuery projectId and dataset are required");
  }
  const location = opts.location?.trim() || undefined;
  const doFetch = opts.fetchImpl ?? fetch;
  const sa = opts.accessToken ? null : parseServiceAccount(opts);
  if (!opts.accessToken && !sa) {
    throw new Error("BigQuery requires service account credentialsJson (or clientEmail + privateKey)");
  }

  let cachedToken: { token: string; expiresAt: number } | null = opts.accessToken
    ? { token: opts.accessToken, expiresAt: Number.POSITIVE_INFINITY }
    : null;

  async function getAccessToken(signal?: AbortSignal): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
      return cachedToken.token;
    }
    const key = await importPKCS8(sa!.privateKey, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: BQ_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa!.clientEmail)
      .setSubject(sa!.clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);

    const res = await doFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`BigQuery OAuth token exchange failed (${res.status}): ${text.slice(0, 240)}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("BigQuery OAuth response missing access_token");
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return cachedToken.token;
  }

  const quote = (i: string) => `\`${i.replace(/`/g, "\\`")}\``;

  return {
    id: "bigquery",
    label: "Google BigQuery",
    quote,
    dateTrunc(grain, expr) {
      const map: Record<string, string> = {
        day: "DAY",
        week: "WEEK(MONDAY)",
        month: "MONTH",
        quarter: "QUARTER",
        year: "YEAR",
      };
      const unit = map[grain] ?? "DAY";
      return `DATE_TRUNC(CAST(${expr} AS DATE), ${unit})`;
    },
    dateAdd(unit, expr, n) {
      const step = Math.trunc(n);
      return `DATE_ADD(CAST(${expr} AS DATE), INTERVAL ${step} ${unit.toUpperCase()})`;
    },
    toTimezone(expr, timezone) {
      return `DATETIME(TIMESTAMP(${expr}), '${timezone.replace(/'/g, "''")}')`;
    },
    relation(table, physical) {
      const proj = physical?.database || projectId;
      const ds = physical?.schema || dataset;
      const tbl = physical?.table || table;
      return `${quote(proj)}.${quote(ds)}.${quote(tbl)}`;
    },

    async execute(sql: string, limit = 5000, _cacheKey?: string, options?: ExecutionOptions): Promise<QueryResult> {
      const budget = executionBudget(options);
      const t0 = performance.now();
      try {
        const token = await getAccessToken(budget.signal);
        const timeoutMs = Math.max(1000, Math.min(300_000, Math.round(options?.timeoutMs ?? 30_000)));
        const res = await doFetch(`${BQ_BASE}/projects/${encodeURIComponent(projectId)}/queries`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: sql,
            useLegacySql: false,
            defaultDataset: { projectId, datasetId: dataset },
            maxResults: limit,
            timeoutMs,
            ...(location ? { location } : {}),
          }),
          signal: budget.signal,
        });
        const body = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) {
          throw new Error(body?.error?.message ?? `BigQuery query failed (${res.status})`);
        }
        let payload = body;
        if (payload.jobComplete === false && payload.jobReference?.jobId) {
          const jobId = encodeURIComponent(payload.jobReference.jobId);
          const locParam = location ? `&location=${encodeURIComponent(location)}` : "";
          const poll = await doFetch(
            `${BQ_BASE}/projects/${encodeURIComponent(projectId)}/queries/${jobId}?maxResults=${limit}&timeoutMs=${timeoutMs}${locParam}`,
            { headers: { authorization: `Bearer ${token}` }, signal: budget.signal },
          );
          payload = await poll.json();
          if (!poll.ok) throw new Error(payload?.error?.message ?? `BigQuery job poll failed (${poll.status})`);
        }
        const fields: { name: string; type: string }[] = payload.schema?.fields ?? [];
        const columns = fields.map((f) => f.name);
        const rawRows: { f?: { v?: unknown }[] }[] = payload.rows ?? [];
        const rows = rawRows.slice(0, limit).map((r) =>
          fields.map((f, idx) => coerceBigQueryCell(r.f?.[idx]?.v, f.type)),
        );
        return {
          columns,
          rows,
          sql,
          ms: Math.round(performance.now() - t0),
        };
      } finally {
        budget.dispose();
      }
    },

    async catalog(): Promise<CatalogTable[]> {
      const token = await getAccessToken();
      const listRes = await doFetch(
        `${BQ_BASE}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(dataset)}/tables?maxResults=200`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!listRes.ok) {
        const body = (await listRes.json().catch(() => ({}))) as any;
        throw new Error(body?.error?.message ?? `BigQuery table listing failed (${listRes.status})`);
      }
      const listJson = (await listRes.json()) as { tables?: { tableReference?: { tableId?: string } }[] };
      const tableIds = (listJson.tables ?? []).map((t) => t.tableReference?.tableId).filter(Boolean) as string[];

      const out: CatalogTable[] = [];
      for (const tableId of tableIds) {
        const metaRes = await doFetch(
          `${BQ_BASE}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(tableId)}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!metaRes.ok) continue;
        const meta = (await metaRes.json()) as { schema?: { fields?: { name: string; type: string }[] } };
        out.push({
          name: tableId,
          columns: (meta.schema?.fields ?? []).map((f) => ({ name: f.name, type: String(f.type).toUpperCase() })),
          relation: { database: projectId, schema: dataset, table: tableId },
        });
      }
      return out;
    },

    async close() {
      cachedToken = null;
    },
  };
}

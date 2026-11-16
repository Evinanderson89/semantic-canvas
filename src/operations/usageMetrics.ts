export interface GovernanceAuditEvent {
  id: string;
  ts: string;
  event: string;
  actor: string | null;
  details: Record<string, unknown>;
}

export interface GovernanceCounters {
  requests: number;
  errors?: number;
  failures?: number;
  queries: number;
  queryErrors?: number;
  queryFailures?: number;
}

export interface GovernanceSourceSummary {
  id: string;
  status: string;
  tables?: number;
  metrics?: number;
}

export interface SecurityEventCounts {
  signedIn: number;
  sessionRevoked: number;
  sessionAccessChanged: number;
  rateLimited: number;
  total: number;
  "auth.signed_in": number;
  "auth.session_revoked": number;
  "auth.session_access_changed": number;
  "audit.rate_limited": number;
}

export interface GovernanceMetrics {
  uniqueActors: number;
  dashboardsSaved: number;
  lockedDashboardsSaved: number;
  dashboardsDeleted: number;
  metricsProposed: number;
  metricsPublished: number;
  scimOperations: number;
  securityEvents: SecurityEventCounts;
  queryReliability: number;
  readySources: number;
  totalGovernedMetrics: number;
  uptimeSeconds: number;
}

export function computeGovernanceMetrics(input: {
  auditEvents: GovernanceAuditEvent[];
  counters: GovernanceCounters;
  sources: GovernanceSourceSummary[];
  uptimeSeconds: number;
}): GovernanceMetrics {
  const actors = new Set<string>();
  let dashboardsSaved = 0;
  let lockedDashboardsSaved = 0;
  let dashboardsDeleted = 0;
  let metricsProposed = 0;
  let metricsPublished = 0;
  let scimOperations = 0;
  let signedIn = 0;
  let sessionRevoked = 0;
  let sessionAccessChanged = 0;
  let rateLimited = 0;

  for (const ev of input.auditEvents) {
    if (typeof ev.actor === "string" && ev.actor.length > 0) {
      actors.add(ev.actor);
    }
    if (ev.event === "audit.dashboard_saved") {
      dashboardsSaved++;
      if (ev.details?.locked === true) {
        lockedDashboardsSaved++;
      }
    } else if (ev.event === "audit.dashboard_deleted") {
      dashboardsDeleted++;
    } else if (ev.event === "audit.metric_proposed") {
      metricsProposed++;
    } else if (ev.event === "audit.metric_published") {
      metricsPublished++;
    } else if (ev.event.startsWith("scim.")) {
      scimOperations++;
    } else if (ev.event === "auth.signed_in") {
      signedIn++;
    } else if (ev.event === "auth.session_revoked") {
      sessionRevoked++;
    } else if (ev.event === "auth.session_access_changed") {
      sessionAccessChanged++;
    } else if (ev.event === "audit.rate_limited") {
      rateLimited++;
    }
  }

  const queries = input.counters.queries ?? 0;
  const queryErrors = input.counters.queryErrors ?? input.counters.queryFailures ?? 0;
  const queryReliability = queries === 0 ? 1 : (queries - queryErrors) / queries;

  const readySourceList = input.sources.filter((s) => s.status === "ready");
  const readySources = readySourceList.length;
  const totalGovernedMetrics = readySourceList.reduce((sum, s) => sum + (s.metrics ?? 0), 0);

  return {
    uniqueActors: actors.size,
    dashboardsSaved,
    lockedDashboardsSaved,
    dashboardsDeleted,
    metricsProposed,
    metricsPublished,
    scimOperations,
    securityEvents: {
      signedIn,
      sessionRevoked,
      sessionAccessChanged,
      rateLimited,
      total: signedIn + sessionRevoked + sessionAccessChanged + rateLimited,
      "auth.signed_in": signedIn,
      "auth.session_revoked": sessionRevoked,
      "auth.session_access_changed": sessionAccessChanged,
      "audit.rate_limited": rateLimited,
    },
    queryReliability,
    readySources,
    totalGovernedMetrics,
    uptimeSeconds: input.uptimeSeconds,
  };
}

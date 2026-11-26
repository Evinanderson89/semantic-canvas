export const RELEASE_MANIFEST = {
  product: "semantic-canvas",
  version: "0.3.6",
  libraryFormatVersion: 2,
  connectedOverlayVersion: 1,
  gatewayPolicyVersion: 1,
  mcpProtocolVersion: "2025-03-26",
  scimSchemaVersion: "2.0",
  supportedAdapters: ["duckglue", "dbt", "snowflake-semantic", "cube"] as const,
  supportedConnectors: ["duckdb", "duckdb-db", "postgres", "bigquery", "snowflake"] as const,
  supportedAiProviders: ["anthropic", "openai", "gemini", "openai-compatible"] as const,
  compatibility: {
    gatewayMinVersion: "0.1.0",
    ingestMinVersion: "0.1.0",
  },
} as const;

export function getReleaseManifest(options?: { mode?: string; aiProvider?: string }) {
  return {
    product: RELEASE_MANIFEST.product,
    version: RELEASE_MANIFEST.version,
    libraryFormatVersion: RELEASE_MANIFEST.libraryFormatVersion,
    connectedOverlayVersion: RELEASE_MANIFEST.connectedOverlayVersion,
    gatewayPolicyVersion: RELEASE_MANIFEST.gatewayPolicyVersion,
    mcpProtocolVersion: RELEASE_MANIFEST.mcpProtocolVersion,
    scimSchemaVersion: RELEASE_MANIFEST.scimSchemaVersion,
    supportedAdapters: [...RELEASE_MANIFEST.supportedAdapters],
    supportedConnectors: [...RELEASE_MANIFEST.supportedConnectors],
    supportedAiProviders: [...RELEASE_MANIFEST.supportedAiProviders],
    compatibility: { ...RELEASE_MANIFEST.compatibility },
    ...(options ?? {}),
  };
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

export function verifySuiteCompatibility(peer: {
  gatewayVersion?: string;
  ingestVersion?: string;
  policyVersion?: number;
  libraryFormatVersion?: number;
}): { compatible: boolean; issues: string[] } {
  const issues: string[] = [];
  const gatewayMin = parseSemver(RELEASE_MANIFEST.compatibility.gatewayMinVersion)!;
  const ingestMin = parseSemver(RELEASE_MANIFEST.compatibility.ingestMinVersion)!;

  if (peer.gatewayVersion !== undefined) {
    const parsed = typeof peer.gatewayVersion === "string" ? parseSemver(peer.gatewayVersion) : null;
    if (!parsed) {
      issues.push(`Invalid gatewayVersion "${String(peer.gatewayVersion)}"; expected major.minor.patch`);
    } else if (compareSemver(parsed, gatewayMin) < 0) {
      issues.push(`gatewayVersion ${peer.gatewayVersion} is below minimum required ${RELEASE_MANIFEST.compatibility.gatewayMinVersion}`);
    }
  }

  if (peer.ingestVersion !== undefined) {
    const parsed = typeof peer.ingestVersion === "string" ? parseSemver(peer.ingestVersion) : null;
    if (!parsed) {
      issues.push(`Invalid ingestVersion "${String(peer.ingestVersion)}"; expected major.minor.patch`);
    } else if (compareSemver(parsed, ingestMin) < 0) {
      issues.push(`ingestVersion ${peer.ingestVersion} is below minimum required ${RELEASE_MANIFEST.compatibility.ingestMinVersion}`);
    }
  }

  if (peer.policyVersion !== undefined) {
    if (peer.policyVersion !== RELEASE_MANIFEST.gatewayPolicyVersion) {
      issues.push(`Unsupported policyVersion ${String(peer.policyVersion)}; expected ${RELEASE_MANIFEST.gatewayPolicyVersion}`);
    }
  }

  if (peer.libraryFormatVersion !== undefined) {
    if (
      typeof peer.libraryFormatVersion !== "number" ||
      !Number.isInteger(peer.libraryFormatVersion) ||
      peer.libraryFormatVersion < 1 ||
      peer.libraryFormatVersion > RELEASE_MANIFEST.libraryFormatVersion
    ) {
      issues.push(`Unsupported libraryFormatVersion ${String(peer.libraryFormatVersion)}; supported up to ${RELEASE_MANIFEST.libraryFormatVersion}`);
    }
  }

  return {
    compatible: issues.length === 0,
    issues,
  };
}

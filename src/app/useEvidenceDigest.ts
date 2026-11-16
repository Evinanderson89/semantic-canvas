import { useEffect, useState } from "react";
import { canonicalEvidence, digestEvidence } from "./evidenceFingerprint.ts";

/** A late digest can never certify newer evidence. */
export function useEvidenceDigest(value: unknown | undefined) {
  const key = value === undefined ? undefined : canonicalEvidence(value);
  const [result, setResult] = useState<{ key: string; digest?: string; error?: boolean }>();
  useEffect(() => {
    if (key === undefined) return;
    let active = true;
    void digestEvidence(JSON.parse(key)).then(digest => {
      if (active) setResult({ key, digest });
    }).catch(() => { if (active) setResult({ key, error: true }); });
    return () => { active = false; };
  }, [key]);
  return { digest: result?.key === key ? result?.digest : undefined,
    pending: key !== undefined && result?.key !== key,
    error: key !== undefined && result?.key === key && !!result?.error };
}

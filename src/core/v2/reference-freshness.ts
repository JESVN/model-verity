export type ReferenceFreshness = "current" | "usable" | "stale";

/** Default rolling-product freshness policy.
 * 0–14 days: current; 15–45 days: usable; over 45 days: stale.
 * Invalid or future timestamps fail closed as stale.
 */
export function referenceFreshnessAt(collectedAt: string, now = Date.now()): ReferenceFreshness {
  const collected = Date.parse(collectedAt);
  if (!Number.isFinite(collected) || !Number.isFinite(now) || collected > now) return "stale";
  const ageDays = (now - collected) / 86_400_000;
  if (ageDays <= 14) return "current";
  if (ageDays <= 45) return "usable";
  return "stale";
}

import type { TrustLevel } from "../types";
import { trustMeta } from "../trust";

export function TrustPill({ level }: { level: TrustLevel }) {
  const meta = trustMeta(level);
  return (
    <span className={`trust-pill tone-${meta.tone}`} title={level}>
      <span className="trust-dot" aria-hidden />
      {meta.shortLabel}
      <span className="caption-muted" style={{ fontWeight: 500 }}>
        · {level.replaceAll("_", " ")}
      </span>
    </span>
  );
}

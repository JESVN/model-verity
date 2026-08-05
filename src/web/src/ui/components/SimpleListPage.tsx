import type { HistoryRow, ProviderOption, ReferenceOption, TrustLevel } from "../types";
import { trustMeta } from "../trust";

export function ProvidersPage({ items }: { items: ProviderOption[] }) {
  return (
    <div className="fade-in">
      <h1 className="page-title">供应商</h1>
      <p className="page-sub">管理可信源与待审计的非官方 endpoint。密钥仅掩码显示。</p>
      <div className="list">
        {items.map((p) => (
          <div className="list-item" key={p.id}>
            <div>
              <div className="list-item-title">{p.name}</div>
              <div className="list-item-sub">
                {p.protocol} · {p.baseUrl}
                <br />
                {p.keyMasked} · {p.role}
              </div>
            </div>
            <span className="caption">{p.models.length} models</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReferencesPage({ items }: { items: ReferenceOption[] }) {
  return (
    <div className="fade-in">
      <h1 className="page-title">参考指纹</h1>
      <p className="page-sub">从可信源建立的分布画像，用于对照非官方供应商。</p>
      <div className="list">
        {items.map((r) => (
          <div className="list-item" key={r.id}>
            <div>
              <div className="list-item-title">{r.label}</div>
              <div className="list-item-sub">
                {r.sourceBaseUrl}
                <br />
                {r.enrolledAt} · 覆盖 {r.cellCoverage}
              </div>
            </div>
            <span className="caption">{r.modelClaimed}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrustDot({ level }: { level: TrustLevel }) {
  const m = trustMeta(level);
  return (
    <span className={`trust-pill tone-${m.tone}`} style={{ padding: "4px 10px" }}>
      <span className="trust-dot" />
      {m.shortLabel}
    </span>
  );
}

export function HistoryPage({ items }: { items: HistoryRow[] }) {
  return (
    <div className="fade-in">
      <h1 className="page-title">历史</h1>
      <p className="page-sub">本地验证记录。点选详情将在业务接线后启用。</p>
      <div className="list">
        {items.map((h) => (
          <div className="list-item" key={h.id}>
            <div>
              <div className="list-item-title">
                {h.provider} · {h.model}
              </div>
              <div className="list-item-sub">
                {h.when}
                {h.score != null ? ` · s=${h.score.toFixed(2)}` : ""}
              </div>
            </div>
            <TrustDot level={h.trust} />
          </div>
        ))}
      </div>
    </div>
  );
}

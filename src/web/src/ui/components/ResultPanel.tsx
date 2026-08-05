import type { VerificationResultView } from "../types";
import { formatMs, formatPct, profileLabel } from "../trust";
import { TrustPill } from "./TrustPill";

export interface ResultPanelProps {
  data: VerificationResultView;
  evidenceOpen?: boolean;
  onToggleEvidence?: () => void;
  onRetry?: () => void;
  onBack?: () => void;
  backLabel?: string;
  onReturnToVerify?: () => void;
  onExport?: () => void;
  onRecommendation?: (index: number) => void;
}

function ratio(value: number, denominator: number) { return denominator ? value / denominator : 0; }
function countRate(value: number, denominator: number) { return `${value}/${denominator} · ${formatPct(ratio(value, denominator))}`; }

export function ResultPanel({
  data, evidenceOpen, onToggleEvidence, onRetry, onBack, backLabel = "返回",
  onReturnToVerify, onExport, onRecommendation,
}: ResultPanelProps) {
  const showEvidence = Boolean(evidenceOpen);
  const scorePosition = data.score == null ? undefined : `${Math.min(100, Math.max(0, data.score * 100))}%`;
  const counts = data.reliability.counts;

  return <section className="card card-narrow result-card fade-in" aria-label="验证结果">
    {onBack ? <button type="button" className="page-back" onClick={onBack}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5" /></svg><span>{backLabel}</span></button> : null}
    {data.legacyEvidence ? <div className="framework-pause compact" role="note"><strong>历史证据格式</strong><p>此记录缺少当前框架的完整证据字段，不表示官方认证、来源证明或模型身份概率。</p></div> : null}
    <div className="trust-hero"><TrustPill level={data.trust} /><h1 className="trust-headline">{data.headline}</h1></div>

    <section className="score-card" aria-label="JSD 分数与阈值">
      <div className="score-heading">
        <div><span className="caption-muted">平均 base-2 JSD</span><strong>{data.score == null ? "未形成可比分数" : data.score.toFixed(3)}</strong></div>
        <span className="caption-muted">范围 [0, 1] · 越低越接近参考</span>
      </div>
      {data.thresholds ? <div className="score-scale">
        <div className="scale-track" aria-hidden="true">
          <i className="scale-match" style={{ width: `${data.thresholds.match * 100}%` }} />
          <i className="scale-mid" style={{ left: `${data.thresholds.match * 100}%`, width: `${(data.thresholds.mid - data.thresholds.match) * 100}%` }} />
          <span className="threshold-mark match" style={{ left: `${data.thresholds.match * 100}%` }} />
          <span className="threshold-mark mid" style={{ left: `${data.thresholds.mid * 100}%` }} />
          {scorePosition ? <span className="score-pointer" style={{ left: scorePosition }} /> : null}
        </div>
        <div className="scale-labels"><span>接近参考 ≤ {data.thresholds.match.toFixed(3)}</span><span>不确定 ≤ {data.thresholds.mid.toFixed(3)}</span><span>明显偏离</span></div>
      </div> : null}
    </section>

    <div className="reason-grid">
      <section className="reason-panel"><h2>为何得到此结论</h2><ul>{(data.reasons?.length ? data.reasons : [data.headline]).map((reason) => <li key={reason}>{reason}</li>)}</ul></section>
      <section className="reason-panel"><h2>证据质量检查</h2><div className="quality-list">{(data.qualityChecks ?? []).map((check) => <div className={`quality-item tone-${check.status}`} key={`${check.label}-${check.detail}`}><span className="quality-status">{check.status === "pass" ? "通过" : check.status === "warn" ? "注意" : "未通过"}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div></div>)}</div></section>
    </div>

    <div className="metric-row">
      <div className="metric"><div className="metric-value">{formatPct(data.reliability.successRate)}</div><div className="metric-label">请求成功率{counts ? ` · ${counts.succeeded}/${counts.planned}` : ""}</div></div>
      <div className="metric"><div className="metric-value">{formatMs(data.reliability.p95ms)}</div><div className="metric-label">响应延迟 p95</div></div>
      <div className="metric"><div className="metric-value">{formatPct(data.reliability.invalidRate)}</div><div className="metric-label">格式无效/拒绝/空响应</div></div>
    </div>

    <section className="recommendation-panel"><h2>建议下一步</h2><ul>{(data.recommendations ?? ["根据当前证据选择更完整档位复核；结论不是厂商认证。"]).map((item, index) => <li key={item}>{item}{onRecommendation ? <button type="button" className="inline-action" onClick={() => onRecommendation(index)}>前往处理</button> : null}</li>)}</ul></section>

    <div className="meta-grid run-summary">
      {data.runInfo ? <>
        <div>供应商 <strong>{data.runInfo.providerName ?? "历史记录未保存"}</strong></div>
        <div>Endpoint <strong>{data.runInfo.endpoint ?? "历史记录未保存"}</strong></div>
        <div>请求模型 <strong>{data.runInfo.requestedModel}</strong> · 声称模型 <strong>{data.runInfo.claimedModel}</strong></div>
        <div>请求 <strong>{data.runInfo.completedRequests ?? "?"}/{data.runInfo.plannedRequests ?? "?"}</strong> · {profileLabel(data.profile)} · cells {data.cellsUsed}</div>
        <div>时间 <strong>{data.runInfo.startedAt ?? "未知"}</strong>{data.runInfo.finishedAt ? ` 至 ${data.runInfo.finishedAt}` : ""}{data.runInfo.elapsed ? ` · ${data.runInfo.elapsed}` : ""}</div>
      </> : <div className="legacy-note">历史记录未保存完整运行快照；不根据当前设置推算。</div>}
      <div>参考 <strong>{data.reference.label}</strong><div className="caption-muted">{data.reference.enrolledAt}</div>{data.reference.sourceType === "builtin-research" ? <div className="reference-attribution">研究参考 · {data.reference.license ?? "CC BY 4.0"}{data.reference.datasetDoi ? ` · DOI ${data.reference.datasetDoi}` : ""}<br />OpenRouter 历史快照，不是厂商认证</div> : null}</div>
      <div className="caption-muted">{data.protocolNote ?? "历史记录未保存协议完整性快照"}</div>
      {data.responseModelNote ? <div className="weak-signal">弱信号：{data.responseModelNote}</div> : null}
    </div>

    <div className="btn-row"><button type="button" className="btn btn-primary" onClick={onRetry}>再测一次</button>{onReturnToVerify ? <button type="button" className="btn btn-secondary" onClick={onReturnToVerify}>返回验证</button> : null}<button type="button" className="btn btn-secondary" onClick={onToggleEvidence}>{showEvidence ? "收起依据" : "查看依据"}</button><button type="button" className="btn btn-ghost" onClick={onExport}>导出</button></div>

    {showEvidence ? <div className="evidence fade-in-soft">
      <h3>采样与错误明细</h3>
      {counts ? <div className="evidence-count-grid">
        <span>有效样本 <strong>{countRate(counts.valid, counts.planned)}</strong></span>
        <span>格式无效 <strong>{countRate(counts.invalid, counts.succeeded)}</strong></span>
        <span>拒绝 <strong>{countRate(counts.refusal, counts.succeeded)}</strong></span>
        <span>空响应 <strong>{countRate(counts.empty, counts.succeeded)}</strong></span>
        <span>请求错误 <strong>{countRate(counts.failed, counts.planned)}</strong></span>
        <span>延迟 p50 / p95 <strong>{formatMs(data.reliability.p50ms ?? 0)} / {formatMs(data.reliability.p95ms)}</strong></span>
      </div> : <p className="legacy-note">此记录由旧版本生成，未保存细分样本计数。</p>}
      {data.reliability.errorClasses ? <p className="caption-muted">错误分类：{Object.entries(data.reliability.errorClasses).map(([key, value]) => `${key} ${value}`).join(" · ") || "无"}</p> : null}
      <h3>已纳入平均 JSD 的 cell</h3>
      {(data.cells ?? []).map((cell) => <div className="cell-bar" key={cell.cellId}><span className="label"><strong>{cell.label}</strong><small>{cell.cellId}</small></span><span className="value">{cell.jsd.toFixed(3)} · ref {cell.nRef ?? "?"} / audit {cell.nValid}</span><div className="track"><i style={{ width: `${Math.min(100, cell.jsd * 100)}%` }} /></div></div>)}
      {(!data.cells || !data.cells.length) ? <p className="caption">无已纳入 cell。</p> : null}
      <h3>已排除的 cell</h3>
      {(data.excludedCells ?? []).map((cell) => <div className="excluded-cell" key={cell.cellId}><div><strong>{cell.label}</strong><small>{cell.cellId}</small></div><span>{cell.reason}</span><span className="caption-muted">ref {cell.nRef ?? "?"} · audit {cell.nAudit ?? "?"} · 最低 {cell.minValid}</span></div>)}
      {(!data.excludedCells || !data.excludedCells.length) ? <p className="caption">无排除项。</p> : null}
      {data.runInfo ? <div className="technical-meta"><h3>技术快照</h3><code>Run ID: {data.runInfo.runId}</code><code>Battery: {data.runInfo.batteryVersion ?? "unknown"}</code><code>Normalizer: {data.runInfo.normalizeVersion ?? "unknown"}</code><code>System prompt: {data.runInfo.systemPromptVersion ?? "unknown"}</code></div> : null}
      <p className="caption-muted">分数是可比 cell 的平均 base-2 JSD。排除表示证据不足，不表示行为偏离；返回 model 字段可由供应商声明，仅作为弱信号。</p>
    </div> : null}
  </section>;
}

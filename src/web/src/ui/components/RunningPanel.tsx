import type { RunningView } from "../types";
import { profileLabel } from "../trust";
import { ProgressRing } from "./ProgressRing";

export interface RunningPanelProps {
  data: RunningView;
  onCancel?: () => void;
}

export function RunningPanel({ data, onCancel }: RunningPanelProps) {
  const pctWidth = `${Math.round(Math.min(1, Math.max(0, data.progress)) * 100)}%`;

  return (
    <section className="card card-narrow fade-in" aria-label="验证进行中" aria-live="polite">
      <div className="progress-hero">
        <ProgressRing value={data.progress} profileLabel={profileLabel(data.profile)} />
        <div>
          <div style={{ fontWeight: 600, letterSpacing: "-0.02em" }}>{data.phaseLabel}</div>
          <div className="caption" style={{ marginTop: 4 }}>
            采样进度 {data.cellCurrent} / {data.cellTotal}
          </div>
        </div>
        <div className="bar" aria-hidden>
          <i style={{ width: pctWidth }} />
        </div>
        <div className="stats-line">
          <span>已用 {data.elapsedLabel}</span>
          <span>成功 {data.successCount}</span>
          <span>失败 {data.failCount}</span>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => onCancel?.()}>
          取消
        </button>
      </div>

      {data.detailLines && data.detailLines.length > 0 ? (
        <details className="details">
          <summary>显示详情</summary>
          <ul>
            {data.detailLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

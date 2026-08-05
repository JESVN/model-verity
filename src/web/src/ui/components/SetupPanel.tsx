import type { SetupView, VerifyProfile } from "../types";
import { profileLabel } from "../trust";
import { Select } from "./Select";

export interface SetupPanelProps {
  data: SetupView;
  onChange?: (patch: Partial<SetupView>) => void;
  onStart?: () => void;
  /** When true, controls are display-only (preview). */
  readOnly?: boolean;
}

const PROFILES: VerifyProfile[] = ["quick", "audit", "full"];

export function SetupPanel({ data, onChange, onStart, readOnly }: SetupPanelProps) {
  const models =
    data.providers.find((p) => p.id === data.selectedProviderId)?.models ?? [];

  return (
    <section className="card card-narrow fade-in" aria-label="验证设置">
      <h1 className="page-title">验证</h1>
      <p className="page-sub">
        使用参考样本比较当前服务的行为分布，并单独展示证据质量。
      </p>

      <fieldset className="paused-controls" disabled={readOnly}> 
      <div className="field">
        <label htmlFor="provider">审计供应商</label>
        <Select
          id="provider"
          disabled={readOnly}
          value={data.selectedProviderId ?? ""}
          placeholder="选择供应商"
          emptyMessage="没有可用于审计的供应商"
          options={data.providers.map((provider) => ({ value: provider.id, label: provider.name }))}
          onChange={(value) =>
            onChange?.({
              selectedProviderId: value || null,
              selectedModel: null,
            })
          }
        />
        {!readOnly && data.providers.length === 0 ? (
          <span className="caption">没有可用于审计的供应商。请在“供应商”页将角色设为“审计”或“两者”。</span>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="model">模型</label>
        <Select
          id="model"
          disabled={readOnly || !data.selectedProviderId}
          value={data.selectedModel ?? ""}
          placeholder="选择模型"
          options={models.map((model) => ({ value: model, label: model }))}
          onChange={(value) => onChange?.({ selectedModel: value || null })}
        />
      </div>

      <div className="field">
        <label htmlFor="claimed">声称身份</label>
        <input
          id="claimed"
          disabled={readOnly}
          value={data.claimedModel}
          placeholder="例如 grok-4.5"
          onChange={(e) => onChange?.({ claimedModel: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="reference">参考指纹</label>
        <Select
          id="reference"
          disabled={readOnly}
          searchable
          searchPlaceholder="搜索模型、来源或标签"
          emptyMessage="没有匹配的参考指纹"
          value={data.selectedReferenceId ?? ""}
          placeholder="选择参考"
          options={data.references.map((reference) => ({
            value: reference.id,
            label: reference.sourceType === "builtin-research"
              ? reference.modelClaimed
              : reference.label,
            keywords: `${reference.modelClaimed} ${reference.label} ${reference.sourceBaseUrl}`,
            badge: reference.sourceType === "builtin-research" ? "研究参考" : "自建",
            badgeTone: reference.sourceType === "builtin-research" ? "builtin" : "local",
          }))}
          onChange={(value) =>
            onChange?.({ selectedReferenceId: value || null })
          }
        />
        {!data.selectedReferenceId ? (
          <span className="caption">
            {data.disabledReason ??
              "需要先从可信源建立参考指纹，才能给出真实性结论。"}
          </span>
        ) : (
          <span className="caption-muted">
            {(() => {
              const selected = data.references.find((reference) => reference.id === data.selectedReferenceId);
              return selected?.sourceType === "builtin-research"
                ? "OpenRouter 研究快照 · CC BY 4.0 · 非厂商认证"
                : selected?.sourceBaseUrl;
            })()}
          </span>
        )}
      </div>

      <div className="field">
        <label>采样档位</label>
        <div className="segmented" role="tablist" aria-label="采样档位">
          {PROFILES.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={data.profile === p}
              className={data.profile === p ? "is-active" : ""}
              disabled={readOnly}
              onClick={() => onChange?.({ profile: p })}
            >
              {profileLabel(p)}
            </button>
          ))}
        </div>
      </div>

      <p className="caption" style={{ marginBottom: 16 }}>
        约 {data.estimatedRequests} 次请求 · 预计 {data.estimatedMinutes} 分钟
      </p>

      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={readOnly || !data.canStart}
        onClick={() => onStart?.()}
      >
        开始验证
      </button>
      </fieldset>
    </section>
  );
}

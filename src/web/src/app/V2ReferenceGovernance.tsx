import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LoadingState, RunningPanel, Select } from "@ui/index";
import { api, type ApiProtocol, type ApiProvider, type ApiV2Run } from "./api";
import { V2BuiltinLibraryUpdate } from "./V2BuiltinLibraryUpdate";
import {
  PROTOCOL_OPTIONS,
  REFERENCE_LEVEL_OPTIONS,
  REFERENCE_PROFILE_OPTIONS,
  SAMPLING_BUDGET_HELP,
  SURFACE_OPTIONS,
  apiErrorMessage,
  freshnessHelp,
  freshnessLabel,
  phaseLabel,
  protocolHelp,
  protocolLabel,
  qualityHelp,
  qualityLabel,
  referenceLevelHelp,
  referenceLevelLabel,
  surfaceHelp,
  surfaceLabel,
} from "./terminology";
import {
  generatedReferenceLabel,
  productAfterModelChange,
  referenceGovernanceStatus,
  referenceModelOptions,
  referenceVersionAfterGovernance,
  type ReferenceGovernanceEventType,
  type ReferenceGovernanceStatus,
} from "./reference-form";

const TRACK_KEY = "model-verity.reference-enrollment-track";
const PROFILE_REQUESTS: Record<string, number> = { quick: 20, audit: 80, full: 240 };
const GOVERNANCE_STATUS: Record<ReferenceGovernanceStatus, { label: string; help: string }> = {
  current: { label: "当前可用", help: "采集时间和样本质量均符合要求，可以参与新的验证。" },
  usable: { label: "仍可使用", help: "样本已有一段时间，仍可参与验证，但结论会更保守。" },
  stale: { label: "已过期", help: "样本已不够新，保留版本和旧记录，但不参与新的验证。" },
  review_required: { label: "待复核", help: "来源或质量存在疑问，人工确认前不参与新的验证。" },
  quarantined: { label: "已暂停", help: "该版本已停止参与新的验证，旧记录仍然保留。" },
  superseded: { label: "已被替代", help: "已有更新版本；该版本仅为旧记录保留。" },
};

export function V2ReferenceGovernance({
  providers,
  onChanged,
  onRunChanged,
}: {
  providers: ApiProvider[];
  onChanged?: () => Promise<void>;
  onRunChanged?: (run: ApiV2Run | null) => void;
}) {
  const referenceProviders = providers.filter((value) => value.role !== "audit");
  const [cohorts, setCohorts] = useState<any[]>([]);
  const [versions, setVersions] = useState<any[]>([]);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [governanceBusy, setGovernanceBusy] = useState<ReferenceGovernanceEventType | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [run, setRun] = useState<ApiV2Run | null>(null);
  const [providerId, setProviderId] = useState(referenceProviders[0]?.id ?? "");
  const provider = referenceProviders.find((value) => value.id === providerId) ?? referenceProviders[0];
  const [model, setModel] = useState(provider?.models[0] ?? "");
  const [protocol, setProtocol] = useState<ApiProtocol>(provider?.protocol ?? "openai-compatible");
  const [vendor, setVendor] = useState("");
  const [product, setProduct] = useState(model);
  const [productCustomized, setProductCustomized] = useState(false);
  const [surface, setSurface] = useState("api");
  const [level, setLevel] = useState("L2");
  const [profile, setProfile] = useState("audit");
  const [customLabel, setCustomLabel] = useState("");
  const [temporaryKey, setTemporaryKey] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [remoteMessage, setRemoteMessage] = useState("");
  const timer = useRef<number | null>(null);
  const requests = PROFILE_REQUESTS[profile] ?? 80;
  const generatedLabel = generatedReferenceLabel(provider?.name ?? "", vendor, product, model);
  const enrollmentLabel = customLabel.trim() || generatedLabel;
  const modelOptions = useMemo(
    () => referenceModelOptions(provider?.models ?? [], remoteModels),
    [provider?.models, remoteModels],
  );
  const selectedVersion = versions.find((value) => value.id === selected);

  const reload = async () => {
    const [nextCohorts, nextVersions] = await Promise.all([
      api.referenceCohortsV2(),
      api.referenceVersionsV2(),
    ]);
    setCohorts(nextCohorts);
    setVersions(nextVersions);
    setSelected((current) => current && nextVersions.some((value: any) => value.id === current)
      ? current
      : (nextVersions[0]?.id ?? ""));
  };

  const updateRun = (value: ApiV2Run | null) => {
    setRun(value);
    onRunChanged?.(value);
  };

  const changeProvider = (nextProviderId: string) => {
    const nextProvider = referenceProviders.find((value) => value.id === nextProviderId);
    const nextModel = nextProvider?.models[0] ?? "";
    setProviderId(nextProviderId);
    setModel(nextModel);
    setProtocol(nextProvider?.protocol ?? "openai-compatible");
    setVendor("");
    setProduct(nextModel);
    setProductCustomized(false);
    setSurface("api");
    setCustomLabel("");
    setRemoteModels([]);
    setRemoteMessage("");
  };

  const changeModel = (nextModel: string) => {
    setProduct((current) => productAfterModelChange(current, nextModel, productCustomized));
    setModel(nextModel);
  };

  const discoverModels = async () => {
    if (!provider) return;
    setDiscovering(true);
    setRemoteMessage("");
    try {
      const found = await api.discoverModels({ providerId: provider.id, protocol, baseUrl: provider.baseUrl });
      const configuredCount = found.filter((value) => provider.models.includes(value)).length;
      setRemoteModels(found);
      setRemoteMessage(found.length
        ? `已获取 ${found.length} 个模型，其中 ${configuredCount} 个已配置。未配置模型需先在供应商页加入。`
        : "接口返回成功，但没有可识别的模型 ID。请在供应商页检查配置。");
    } catch (error) {
      setRemoteMessage(apiErrorMessage(error instanceof Error ? error.message : String(error)));
      setRemoteModels([]);
    } finally {
      setDiscovering(false);
    }
  };

  const poll = async (id: string) => {
    try {
      const value = await api.v2Run(id);
      updateRun(value);
      localStorage.setItem(TRACK_KEY, id);
      if (["queued", "running"].includes(value.status)) {
        timer.current = window.setTimeout(() => void poll(id), 500);
      } else {
        timer.current = null;
        setCreating(false);
        localStorage.removeItem(TRACK_KEY);
        await reload();
        await onChanged?.();
      }
    } catch (error) {
      setMessage(apiErrorMessage(error instanceof Error ? error.message : String(error)));
      timer.current = null;
    }
  };

  useEffect(() => {
    const tracked = localStorage.getItem(TRACK_KEY);
    void Promise.all([reload(), tracked ? poll(tracked) : Promise.resolve()])
      .catch((error) => setMessage(apiErrorMessage(error instanceof Error ? error.message : String(error))))
      .finally(() => setInitialLoading(false));
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (!provider) return;
    if (!provider.models.includes(model)) {
      const nextModel = provider.models[0] ?? "";
      setProduct((current) => productAfterModelChange(current, nextModel, productCustomized));
      setModel(nextModel);
    }
  }, [provider?.models]);

  const start = async () => {
    if (!provider || !model || !vendor.trim() || !product.trim() || !enrollmentLabel) return;
    setBusy(true);
    setMessage("");
    try {
      const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const authorization = await api.createBudgetAuthorization({
        providerIds: [provider.id],
        models: [model],
        maxEndpointRequests: requests,
        maxInputTokens: requests * 800,
        maxOutputTokens: requests * 16,
        maxAttemptsPerEndpoint: 1,
        expiresAt,
      });
      const credential = temporaryKey
        ? await api.createCredentialSession("reference", temporaryKey)
        : undefined;
      setTemporaryKey("");
      const value = await api.startReferenceEnrollment({
        providerId: provider.id,
        model,
        protocol,
        label: enrollmentLabel,
        profile,
        referenceLevel: level,
        credentialSessionId: credential?.id,
        identity: { declared: { vendor: vendor.trim(), product: product.trim(), surface } },
        budget: {
          authorizationId: authorization.id,
          maxPairs: requests,
          maxEndpointRequests: requests,
          maxAttemptsPerEndpoint: 1,
          expiresAt,
        },
      });
      updateRun(value);
      localStorage.setItem(TRACK_KEY, value.id);
      void poll(value.id);
    } catch (error) {
      setMessage(apiErrorMessage(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (run) updateRun(await api.cancelV2Run(run.id));
    setCreating(false);
    localStorage.removeItem(TRACK_KEY);
  };

  const addEvent = async (eventType: ReferenceGovernanceEventType) => {
    if (!selectedVersion || governanceBusy) return;
    const previousVersion = selectedVersion;
    const optimisticVersion = referenceVersionAfterGovernance(selectedVersion, eventType);
    setGovernanceBusy(eventType);
    setMessage("");
    setVersions((current) => current.map((value) => value.id === selected ? optimisticVersion : value));
    try {
      const result = await api.addReferenceGovernanceEvent(selected, {
        eventType,
        details: { source: "local administrator UI" },
      });
      setVersions((current) => current.map((value) => value.id === selected ? result.version : value));
      const status = referenceGovernanceStatus(result.version);
      setMessage(`参考状态已切换为“${GOVERNANCE_STATUS[status].label}”。`);
      if (onChanged) {
        void onChanged().catch((error) => {
          setMessage(`状态已更新，但验证列表同步失败：${apiErrorMessage(error instanceof Error ? error.message : String(error))}`);
        });
      }
    } catch (error) {
      setVersions((current) => current.map((value) => value.id === selected ? previousVersion : value));
      setMessage(apiErrorMessage(error instanceof Error ? error.message : String(error)));
    } finally {
      setGovernanceBusy(null);
    }
  };

  if (run && ["queued", "running"].includes(run.status)) {
    return <section className="reference-group">
      <div className="section-heading"><h2 className="section-title">正在创建参考样本</h2></div>
      <RunningPanel
        data={{
          profile: run.profile,
          progress: run.progress,
          phaseLabel: run.phase === "sampling" ? "正在收集参考回答" : phaseLabel(run.phase),
          cellCurrent: Math.max(1, Math.ceil(run.progress * requests)),
          cellTotal: requests,
          elapsedLabel: elapsed(run.startedAt),
          successCount: run.successCount,
          failCount: run.failCount,
          detailLines: [
            `${provider?.name ?? "可信供应商"} · ${run.model} · ${referenceLevelLabel(run.referenceLevel)}`,
            `${requests} 次请求，不自动重试；质量达标后发布新版本。`,
          ],
        }}
        onCancel={() => void cancel()}
      />
    </section>;
  }

  if (initialLoading) {
    return <section className="reference-group">
      <LoadingState compact label="正在加载参考数据" detail="同步参考组和不可变版本" />
    </section>;
  }

  const canStart = Boolean(provider && model && vendor.trim() && product.trim() && enrollmentLabel);
  const currentGovernanceStatus = selectedVersion ? referenceGovernanceStatus(selectedVersion) : "current";
  const currentGovernancePresentation = GOVERNANCE_STATUS[currentGovernanceStatus];

  return <section className="reference-group reference-governance">
    <div className="card reference-overview-card">
      <div className="reference-overview-header">
        <div className="reference-overview-copy">
          <span className="reference-kicker">自建参考</span>
          <h2>采集你信任路径的回答</h2>
          <p>从可信 API 建立可重复使用的对照。样本记录采集时的行为，不证明官方来源。</p>
        </div>
        <div className="reference-counts" aria-label={`${cohorts.length} 个参考组，${versions.length} 个版本`}>
          <span><strong>{cohorts.length}</strong>参考组</span>
          <span><strong>{versions.length}</strong>版本</span>
        </div>
      </div>

      <V2BuiltinLibraryUpdate onLibraryChanged={() => void reload()} />

      {run && !creating
        ? <div className={`connection-inline ${run.status === "completed" ? "is-success" : "is-failed"}`} role="status">
          {run.status === "completed"
            ? `参考样本“${run.result?.referenceEnrollment?.label ?? run.model}”已创建并可用于验证。`
            : run.status === "cancelled"
              ? "参考采集已取消，未发布版本。"
              : `参考采集失败：${run.error ? apiErrorMessage(run.error) : "未知错误"}`}
        </div>
        : null}

      {!creating
        ? <>
          <div className="reference-overview-action">
            <button className="btn btn-primary" disabled={!referenceProviders.length} onClick={() => setCreating(true)}>
              {referenceProviders.length ? "创建参考样本" : "请先添加可信参考供应商"}
            </button>
            <p>新采集会创建独立版本，不覆盖已有样本。</p>
          </div>

          {versions.length
            ? <div className="reference-version-panel">
              <div className="reference-version-heading">
                <div>
                  <h3>已有版本</h3>
                  <p>选择一个版本查看状态，或更新它能否继续参与验证。</p>
                </div>
              </div>
              <ExplainedField label="参考版本" help="过期、待复核或暂停的版本会保留，但不会用于新的验证。">
                <Select
                  searchable
                  value={selected}
                  options={versions.map((value) => ({
                    value: value.id,
                    label: `${referenceLevelLabel(value.level)} · ${value.identity?.product ?? value.id}`,
                    description: `${freshnessLabel(value.freshnessStatus)}：${freshnessHelp(value.freshnessStatus)} ${qualityLabel(value.qualityStatus)}：${qualityHelp(value.qualityStatus)}`,
                  }))}
                  onChange={setSelected}
                />
              </ExplainedField>
              {selectedVersion
                ? <div
                  className={`reference-version-status tone-${currentGovernanceStatus}`}
                  aria-live="polite"
                  aria-busy={Boolean(governanceBusy)}
                >
                  <div className="reference-status-main">
                    <i aria-hidden="true" />
                    <div>
                      <span>当前状态</span>
                      <strong>{currentGovernancePresentation.label}</strong>
                    </div>
                  </div>
                  <div className="reference-status-detail">
                    <div className="reference-status-badges">
                      <span className={`tone-${freshnessTone(selectedVersion.freshnessStatus)}`}>时效 · {freshnessLabel(selectedVersion.freshnessStatus)}</span>
                      <span className={`tone-${qualityTone(selectedVersion.qualityStatus)}`}>质量 · {qualityLabel(selectedVersion.qualityStatus)}</span>
                    </div>
                    <p>{currentGovernancePresentation.help}</p>
                  </div>
                </div>
                : null}
              <div className="reference-governance-actions">
                <div>
                  <h4>更新版本状态</h4>
                  <p>状态变更只影响后续验证，不修改旧记录。</p>
                </div>
                <div className="btn-row compact" aria-label="选择参考版本状态">
                  <button
                    className={`btn reference-state-action tone-current${currentGovernanceStatus === "current" ? " is-active" : ""}`}
                    aria-pressed={currentGovernanceStatus === "current"}
                    disabled={Boolean(governanceBusy)}
                    title="重新确认该版本仍代表你信任的路径；时效恢复为当前有效，质量恢复为已通过。"
                    onClick={() => void addEvent("confirmed")}
                  >确认仍可用</button>
                  <button
                    className={`btn reference-state-action tone-stale${currentGovernanceStatus === "stale" ? " is-active" : ""}`}
                    aria-pressed={currentGovernanceStatus === "stale"}
                    disabled={Boolean(governanceBusy)}
                    title="参考已不够新；保留版本和历史，但不再用于新的验证。"
                    onClick={() => void addEvent("marked_stale")}
                  >标记为过期</button>
                  <button
                    className={`btn reference-state-action tone-review_required${currentGovernanceStatus === "review_required" ? " is-active" : ""}`}
                    aria-pressed={currentGovernanceStatus === "review_required"}
                    disabled={Boolean(governanceBusy)}
                    title="参考来源或质量存在疑问；保留版本，但在人工处理前不用于新的验证。"
                    onClick={() => void addEvent("review_required")}
                  >标记为待复核</button>
                  <button
                    className={`btn reference-state-action tone-quarantined${currentGovernanceStatus === "quarantined" ? " is-active" : ""}`}
                    aria-pressed={currentGovernanceStatus === "quarantined"}
                    disabled={Boolean(governanceBusy)}
                    title="立即停止该版本参与新的验证；不会删除版本或旧历史。"
                    onClick={() => void addEvent("quarantined")}
                  >暂停用于验证</button>
                </div>
              </div>
            </div>
            : <div className="reference-version-empty">
              <strong>还没有自建版本</strong>
              <p>完成首次采集且通过质量门禁后，版本会显示在这里并自动接入验证页。</p>
            </div>}
        </>
        : <div className="reference-configuring-status" role="status">
          <strong>正在配置新参考</strong>
          <span>按下面三个步骤核对采集路径、上游声明和请求预算。</span>
        </div>}
      {message ? <p className="caption-muted reference-message" role="status">{message}</p> : null}
    </div>

    {creating
      ? <div className="card manage-card reference-create-card">
        <section className="reference-form-section" aria-labelledby="reference-source-title">
          <div className="reference-form-heading">
            <span>1</span>
            <div><h3 id="reference-source-title">从哪里采集</h3><p>选择实际发送请求的 API 路径和模型 ID。</p></div>
          </div>
          <div className="manage-grid reference-form-grid">
            <ExplainedField label="你信任的供应商" help="决定请求地址、保存的密钥和实际费用。">
              <Select
                value={provider?.id ?? ""}
                options={referenceProviders.map((value) => ({ value: value.id, label: value.name }))}
                onChange={changeProvider}
              />
            </ExplainedField>
            <ExplainedField
              label="发送给接口的模型 ID"
              help="这是请求中的原始模型名称，不等于系统已经确认的上游模型身份。"
            >
              <div className="reference-model-picker">
                <Select
                  searchable
                  value={model}
                  options={modelOptions}
                  searchPlaceholder="搜索模型 ID"
                  onChange={changeModel}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={discovering || !provider}
                  onClick={() => void discoverModels()}
                >
                  {discovering ? "刷新中…" : "刷新模型列表"}
                </button>
              </div>
              {remoteMessage ? <p className="caption-muted" role="status">{remoteMessage}</p> : null}
            </ExplainedField>
          </div>
          <div className="reference-protocol-summary">
            <span>请求协议</span>
            <strong>{protocolLabel(protocol)}</strong>
            <small>{protocol === provider?.protocol ? "来自供应商配置" : "已在高级设置中覆盖供应商配置"}</small>
          </div>
        </section>

        <section className="reference-form-section" aria-labelledby="reference-identity-title">
          <div className="reference-form-heading">
            <span>2</span>
            <div><h3 id="reference-identity-title">这份参考代表什么</h3><p>区分网关路由名称与它实际代表的上游模型。</p></div>
          </div>
          <div className="manage-grid reference-form-grid">
            <Field
              label="实际上游厂商"
              value={vendor}
              onChange={setVendor}
              placeholder="例如 OpenAI"
              help="填写网关最终连接的模型厂商，不填网关名称；这是你的声明。"
            />
            <ExplainedField
              label="实际上游模型"
              help="默认与模型 ID 相同；如果模型 ID 是网关别名或带路由前缀，请改成实际模型版本。该值用于以后匹配参考。"
            >
              {productCustomized
                ? <div className="reference-linked-input">
                  <input
                    value={product}
                    placeholder="例如 gpt-5.6-sol"
                    onChange={(event) => setProduct(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => { setProduct(model); setProductCustomized(false); }}
                  >与模型 ID 相同</button>
                </div>
                : <div className="reference-linked-value">
                  <strong>{model || "请先选择模型 ID"}</strong>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!model}
                    onClick={() => setProductCustomized(true)}
                  >模型 ID 是别名，修改</button>
                </div>}
            </ExplainedField>
            <ExplainedField
              label="网关最终连接的使用方式"
              help={surfaceHelp(surface)}
            >
              <Select value={surface} options={SURFACE_OPTIONS} onChange={setSurface} />
            </ExplainedField>
            <ExplainedField label="这条参考路径的可信程度" help={referenceLevelHelp(level)}>
              <Select value={level} options={REFERENCE_LEVEL_OPTIONS} onChange={setLevel} />
            </ExplainedField>
          </div>
        </section>

        <section className="reference-form-section" aria-labelledby="reference-budget-title">
          <div className="reference-form-heading">
            <span>3</span>
            <div><h3 id="reference-budget-title">选择采集规模</h3><p>样本越多通常越稳定，同时增加费用和等待时间。</p></div>
          </div>
          <div className="reference-budget-field">
            <ExplainedField
              label="采集预算"
              help={`${REFERENCE_PROFILE_OPTIONS.find((item) => item.value === profile)?.description ?? SAMPLING_BUDGET_HELP} 系统不会自动重试或增加预算。`}
            >
              <Select value={profile} options={REFERENCE_PROFILE_OPTIONS} onChange={setProfile} />
            </ExplainedField>
          </div>
        </section>

        <div className="reference-create-summary" aria-live="polite">
          <span>将创建</span>
          <strong>{enrollmentLabel || "请补全上游信息"}</strong>
          <p>
            {provider?.name ?? "未选择供应商"} · 模型 ID {model || "未选择"} · {protocolLabel(protocol)}<br />
            声明为 {vendor.trim() || "未填写厂商"} {product.trim() || "未填写模型"} · {surfaceLabel(surface)} · {referenceLevelLabel(level)}
          </p>
        </div>

        <details className="advanced-verification reference-advanced">
          <summary>高级设置</summary>
          <p className="field-help">仅在自定义列表名称、覆盖供应商协议或临时换用 API Key 时设置。</p>
          <div className="advanced-grid">
            <Field
              label="自定义显示名称（可选）"
              value={customLabel}
              onChange={setCustomLabel}
              placeholder={generatedLabel || "自动按供应商、模型和月份生成"}
              help="只影响列表显示，不参与评分；留空时自动生成。"
            />
            <ExplainedField label="覆盖请求协议" help={protocolHelp(protocol)}>
              <ProtocolSelect value={protocol} onChange={setProtocol} />
            </ExplainedField>
            <ExplainedField
              label="临时参考端 API Key（可选）"
              help="留空则使用已保存密钥。填写后仅存内存，并在完成、失败、取消、过期或重启后销毁。"
            >
              <input
                id="reference-temporary-key"
                type="password"
                autoComplete="off"
                value={temporaryKey}
                onChange={(event) => setTemporaryKey(event.target.value)}
                placeholder="留空则使用供应商已保存密钥"
              />
            </ExplainedField>
          </div>
        </details>

        <div className="cost-notice">
          最多 {requests} 次请求；约 {requests * 800} 个输入 token、{requests * 16} 个输出 token（计费文本单位）。不重试或追加预算。成功率 ≥90%、有效问题 ≥75%、隐藏推理关闭且清单完整时才发布。
        </div>
        <div className="btn-row">
          <button className="btn btn-secondary" disabled={busy} onClick={() => setCreating(false)}>取消</button>
          <button className="btn btn-primary" disabled={busy || !canStart} onClick={() => void start()}>
            {busy ? "授权中…" : `批准并启动 ${requests} 次请求`}
          </button>
        </div>
      </div>
      : null}
  </section>;
}

function ProtocolSelect({ value, onChange }: { value: ApiProtocol; onChange: (value: ApiProtocol) => void }) {
  return <Select value={value} options={PROTOCOL_OPTIONS} onChange={(next) => onChange(next as ApiProtocol)} />;
}

function ExplainedField({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}<p className="field-help">{help}</p></div>;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  help?: string;
}) {
  return <div className="field">
    <label>{label}</label>
    <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    {help ? <p className="field-help">{help}</p> : null}
  </div>;
}

function freshnessTone(value: string | undefined) {
  return value === "stale" ? "stale" : value === "usable" ? "usable" : "current";
}

function qualityTone(value: string | undefined) {
  return value === "review_required" ? "review_required"
    : value === "quarantined" ? "quarantined"
      : value === "superseded" ? "superseded"
        : "current";
}

function elapsed(start?: string) {
  if (!start) return "0:00";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

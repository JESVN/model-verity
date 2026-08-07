import { useEffect, useRef, useState } from "react";
import { api, type ApiZenodoProxyInfo, type ApiZenodoProxyTestResult, type ApiZenodoUpdateStatus } from "./api";
import { BUILTIN_UPDATE_COPY as copy, apiErrorMessage } from "./terminology";

function formatBytes(value: number): string {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(value / 1024))} KB`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function pendingCatalogCounts(status: ApiZenodoUpdateStatus) {
  const current = new Set(status.current.modelIds);
  const applied = new Set(status.catalog.appliedModelIds);
  const qualified = status.catalog.models.filter((model) => model.qualified);
  return {
    currentQualified: qualified.filter((model) => current.has(model.model)).length,
    existingPending: qualified.filter((model) => current.has(model.model) && !applied.has(model.model)).length,
    newPending: qualified.filter((model) => !current.has(model.model) && !applied.has(model.model)).length,
  };
}

type Phase = "idle" | "checking" | "error" | "downloading" | "update_available" | "up_to_date" | "catalog";

const PHASE_COPY: Record<Phase, string> = {
  idle: "未检查",
  checking: "检查中…",
  error: "检查失败",
  downloading: "下载中…",
  update_available: "发现新版本",
  up_to_date: "已是最新版本",
  catalog: "发现新版本",
};
const PHASE_TONE: Record<Phase, string> = {
  idle: "neutral",
  checking: "running",
  error: "failed",
  downloading: "running",
  update_available: "review_required",
  up_to_date: "current",
  catalog: "review_required",
};

/**
 * 内置研究参考更新：检查 Zenodo 新版本 -> 下载并准备数据集 -> 勾选模型更新。
 * 保留最近 3 个版本可回滚，数据集缓存一键清理，可配置代理。
 */
export function V2BuiltinLibraryUpdate({ onLibraryChanged }: { onLibraryChanged?: () => void }) {
  const [status, setStatus] = useState<ApiZenodoUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [builtinQuery, setBuiltinQuery] = useState("");
  const [newQuery, setNewQuery] = useState("");
  const [showUnqualified, setShowUnqualified] = useState(false);
  const [checkOutcome, setCheckOutcome] = useState<{ kind: "available" | "latest" | "failed"; message: string } | null>(null);
  const [applyRequestFailure, setApplyRequestFailure] = useState<{ action: "update" | "download"; modelIds: string[]; error: string } | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [proxyInfo, setProxyInfo] = useState<ApiZenodoProxyInfo | null>(null);
  const [proxyInput, setProxyInput] = useState("");
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTest, setProxyTest] = useState("");
  const timer = useRef<number | null>(null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setStatus(await api.builtinLibraryUpdateStatus());
      setProxyInfo(await api.builtinLibraryProxyInfo());
      setError("");
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, []);

  const pollJob = (jobId: string) => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      try {
        const job = await api.builtinLibraryUpdateJob(jobId);
        setStatus((current) => current ? {
          ...current,
          ...(job.kind === "prepare" ? { prepareJob: job } : { applyJob: job }),
        } : current);
        if (job.status === "done" || job.status === "failed" || job.status === "canceled") {
          if (timer.current) window.clearInterval(timer.current);
          timer.current = null;
          if (job.kind === "prepare") {
            if (job.status === "done") { setNotice(copy.prepareDone); await load(true); }
            else if (job.status === "canceled") setNotice("已取消数据集下载。");
          } else if (job.status === "done") {
            setSelected((current) => {
              const next = new Set(current);
              for (const modelId of job.modelIds ?? []) next.delete(modelId);
              return next;
            });
            setNotice("");
            await load(true);
            onLibraryChanged?.();
          }
        }
      } catch (value) {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
      }
    }, 600);
  };

  useEffect(() => {
    const active = [status?.prepareJob, status?.applyJob].find((job) => job && (job.status === "queued" || job.status === "running"));
    if (active && !timer.current) pollJob(active.id);
    // The job id/status pair changes only when polling must start or stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.prepareJob?.id, status?.prepareJob?.status, status?.applyJob?.id, status?.applyJob?.status]);

  const check = async () => {
    setChecking(true);
    setNotice("");
    setError("");
    setCheckOutcome(null);
    setApplyRequestFailure(null);
    try {
      const next = await api.builtinLibraryUpdateCheck(true);
      setStatus(next);
      if (next.lastError) {
        setCheckOutcome({ kind: "failed", message: apiErrorMessage(next.lastError) });
      } else if (!next.catalog.ready && next.updateAvailable) {
        setCheckOutcome({ kind: "available", message: "发现新的 Zenodo 数据版本，请先下载数据到本地。" });
      } else {
        const pending = pendingCatalogCounts(next);
        if (pending.existingPending > 0) {
          setCheckOutcome({ kind: "available", message: `发现 ${pending.existingPending} 个现有内置样本可更新。` });
        } else {
          setCheckOutcome({
            kind: "latest",
            message: pending.newPending > 0
              ? `现有内置样本已是最新版本；另有 ${pending.newPending} 个新样本可按需下载。`
              : "当前内置样本已是最新版本，无需更新。",
          });
        }
      }
    } catch (value) {
      const message = apiErrorMessage(value instanceof Error ? value.message : String(value));
      setStatus((current) => current ? { ...current, lastError: message } : current);
      setCheckOutcome({ kind: "failed", message });
    } finally {
      setChecking(false);
    }
  };

  const prepare = async () => {
    setNotice("");
    setError("");
    try {
      const job = await api.builtinLibraryUpdatePrepare();
      setStatus((current) => (current ? { ...current, prepareJob: job } : current));
      pollJob(job.id);
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
    }
  };

  const applySelected = async (modelIds: string[], action: "update" | "download") => {
    const ids = [...modelIds].sort((a, b) => a.localeCompare(b));
    if (!ids.length) { setError(action === "update" ? "请先勾选要更新的模型。" : "请先勾选要下载的模型。"); return; }
    setError("");
    setNotice("");
    setApplyRequestFailure(null);
    try {
      const job = await api.builtinLibraryUpdateApply(ids, action);
      setStatus((current) => current ? { ...current, applyJob: job } : current);
      pollJob(job.id);
    } catch (value) {
      setApplyRequestFailure({
        action,
        modelIds: ids,
        error: apiErrorMessage(value instanceof Error ? value.message : String(value)),
      });
    }
  };

  const rollback = async () => {
    setRollingBack(true);
    setError("");
    try {
      const next = await api.builtinLibraryUpdateRollback();
      setStatus(next);
      setNotice("已回滚到上一版本。");
      onLibraryChanged?.();
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
    } finally {
      setRollingBack(false);
    }
  };

  const cleanCache = async () => {
    setCleaning(true);
    setError("");
    try {
      const result = await api.builtinLibraryUpdateCleanCache();
      setNotice(`数据集缓存已清理（释放 ${formatBytes(result.freedBytes)}）。`);
      await load(true);
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
    } finally {
      setCleaning(false);
    }
  };

  const toggleModel = (model: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(model)) next.delete(model); else next.add(model);
      return next;
    });
  };

  const cancelJob = async () => {
    const current = status?.prepareJob;
    if (!current) return;
    try {
      const next = await api.builtinLibraryUpdateCancelJob(current.id);
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
      setStatus(next);
      setNotice("已取消数据集下载。");
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
    }
  };

  const saveProxy = async () => {
    setError("");
    setProxyTest("");
    try {
      const next = await api.builtinLibrarySetProxy(proxyInput.trim() || null);
      setProxyInfo(next);
      setProxyInput("");
      setNotice(copy.proxyUpdated);
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
    }
  };

  const clearProxy = async () => {
    setError("");
    setProxyTest("");
    try {
      const next = await api.builtinLibrarySetProxy(null);
      setProxyInfo(next);
      setNotice(copy.proxyCleared);
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
    }
  };

  const testProxy = async () => {
    setProxyTesting(true);
    setProxyTest("");
    try {
      const result: ApiZenodoProxyTestResult = await api.builtinLibraryTestProxy();
      setProxyTest(result.ok
        ? `${copy.proxyTestOk}（${result.latencyMs}ms）`
        : `${copy.proxyTestFail}：${result.error ?? "不可达"}`);
    } catch (value) {
      setProxyTest(`${copy.proxyTestFail}：${apiErrorMessage(value instanceof Error ? value.message : String(value))}`);
    } finally {
      setProxyTesting(false);
    }
  };

  const selectCurrentBuiltin = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const model of pendingBuiltinModels) next.add(model.model);
      return next;
    });
  };

  const toggleGroup = (models: Array<{ model: string; qualified: boolean }>) => {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = models.every((model) => next.has(model.model));
      for (const model of models) { if (allSelected) next.delete(model.model); else next.add(model.model); }
      return next;
    });
  };

  const catalogModels = status?.catalog.models ?? [];
  const unqualifiedCount = Math.max(0, catalogModels.length - (status?.catalog.qualified ?? 0));
  const trimmedBuiltinQuery = builtinQuery.trim().toLowerCase();
  const trimmedNewQuery = newQuery.trim().toLowerCase();
  const currentBuiltinIds = new Set(status?.current.modelIds ?? []);
  const appliedModelIds = new Set(status?.catalog.appliedModelIds ?? []);
  const currentQualifiedModels = catalogModels.filter((model) => model.qualified && currentBuiltinIds.has(model.model));
  const pendingBuiltinModels = currentQualifiedModels.filter((model) => !appliedModelIds.has(model.model));
  const pendingNewModels = catalogModels.filter((model) => model.qualified && !currentBuiltinIds.has(model.model) && !appliedModelIds.has(model.model));
  const builtinModels = trimmedBuiltinQuery
    ? pendingBuiltinModels.filter((model) => model.model.toLowerCase().includes(trimmedBuiltinQuery))
    : pendingBuiltinModels;
  const newModels = trimmedNewQuery
    ? pendingNewModels.filter((model) => model.model.toLowerCase().includes(trimmedNewQuery))
    : pendingNewModels;
  const unqualifiedModels = catalogModels.filter((model) => !model.qualified);
  const selectedIn = (models: typeof catalogModels) => models.filter((model) => selected.has(model.model)).length;
  const selectedIdsIn = (models: typeof catalogModels) => models.filter((model) => selected.has(model.model)).map((model) => model.model);
  const catalogReady = Boolean(status?.catalog.ready && status.catalog.models.length);

  // Keep the common update path one click away, but never reselect entries already applied from this record.
  useEffect(() => {
    if (catalogReady && selected.size === 0 && builtinModels.length > 0) selectCurrentBuiltin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogReady, status?.catalog.recordId, status?.catalog.total, status?.catalog.appliedModelIds.length]);
  const prepareJob = status?.prepareJob;
  const prepareActive = Boolean(prepareJob && (prepareJob.status === "queued" || prepareJob.status === "running"));
  const applyJob = status?.applyJob;
  const applyActive = Boolean(applyJob && (applyJob.status === "queued" || applyJob.status === "running"));
  const operationActive = prepareActive || applyActive;
  const existingPendingCount = pendingBuiltinModels.length;
  const newPendingCount = pendingNewModels.length;
  const currentAppliedCount = currentQualifiedModels.length - existingPendingCount;
  const canRollback = (status?.versions.length ?? 0) > 1;
  const hasChecked = Boolean(status?.latest);

  const phase: Phase = checking
    ? "checking"
    : prepareActive
      ? "downloading"
      : status?.lastError
        ? "error"
        : catalogReady && existingPendingCount > 0
          ? "catalog"
          : !catalogReady && status?.updateAvailable
            ? "update_available"
            : hasChecked
              ? "up_to_date"
              : "idle";

  const latestText = status?.latest
    ? `${status.latest.version ?? "（未标注版本）"} · 更新 ${formatDate(status.latest.updated)}`
    : "";
  const currentText = status
    ? `${status.current.revision ? `v${status.current.revision}` : status.current.libraryVersion} · ${status.current.models} 模型`
    : "加载中…";
  const currentSource = status
    ? `${status.current.source === "runtime" ? "运行时更新" : "打包基线"} · 采集 ${formatDate(status.current.collectedAt)}`
    : "";

  return (
    <section className="reference-group builtin-update-group">
      <div className="card builtin-update-card">
        <div className="builtin-update-header">
          <div>
            <h2 className="section-title">{copy.title}</h2>
            <p className="builtin-update-subtitle">内置研究参考来自 Zenodo 数据集，发现新版本后可下载并更新。</p>
          </div>
          <button className="btn btn-primary" disabled={checking || operationActive} aria-busy={checking} onClick={() => void check()}>
            {checking ? <><span className="builtin-loading-grid" aria-hidden="true"><span /><span /><span /><span /></span>检查中…</> : (hasChecked ? copy.refresh : copy.check)}
          </button>
        </div>

        {error && <div className="connection-inline is-failed fade-in-soft" role="alert">{error}</div>}
        {notice && <div className="connection-inline is-success fade-in-soft" role="status">{notice}</div>}
        {checkOutcome && !checking && (
          <div className={`builtin-operation-feedback is-${checkOutcome.kind} fade-in-soft`} role={checkOutcome.kind === "failed" ? "alert" : "status"}>
            <div>
              <strong>{checkOutcome.kind === "available" ? "发现新版本" : checkOutcome.kind === "latest" ? "已是最新版本" : "检查更新失败"}</strong>
              <span>{checkOutcome.message}</span>
            </div>
            {checkOutcome.kind === "failed" && <button className="btn btn-ghost" onClick={() => void check()}>重试检查</button>}
          </div>
        )}

        {/* 版本状态条：当前 -> 最新 */}
        <div className="builtin-status-strip fade-in-soft" role="status" aria-live="polite">
          <div className="builtin-status-cell">
            <span className="builtin-status-label">当前内置库</span>
            <span className="builtin-status-value">
              {status && <span className={`builtin-source-dot tone-${status.current.source === "runtime" ? "runtime" : "baseline"}`} aria-hidden="true" />}
              {currentText}
            </span>
            <span className="builtin-status-dim">{currentSource}</span>
          </div>
          <div className="builtin-status-arrow" aria-hidden="true">→</div>
          <div className="builtin-status-cell">
            <span className="builtin-status-label">Zenodo 最新</span>
            <span className={`builtin-status-chip tone-${PHASE_TONE[phase]}`}>
              {(phase === "checking" || phase === "downloading") && (
                <span className="builtin-loading-grid" aria-hidden="true"><span /><span /><span /><span /></span>
              )}
              {PHASE_COPY[phase]}
            </span>
            <span className="builtin-status-dim">
              {phase === "up_to_date" || phase === "update_available" || phase === "catalog"
                ? latestText
                : phase === "checking"
                  ? "正在查询 Zenodo…"
                  : phase === "error"
                    ? "上次检查未成功"
                    : ""}
            </span>
          </div>
        </div>

        {prepareJob?.status === "failed" && !catalogReady && (
          <div className="builtin-operation-feedback is-failed fade-in-soft" role="alert">
            <div><strong>下载数据失败</strong><span>{apiErrorMessage(prepareJob.error ?? "数据集准备失败。")}</span></div>
            <button className="btn btn-ghost" onClick={() => void prepare()}>重试下载</button>
          </div>
        )}

        {/* 发现新版本 -> 下载准备 */}
        {status?.updateAvailable && !catalogReady && !prepareActive && (
          <div className="builtin-update-panel is-new fade-in-soft" key="prepare">
            <div className="builtin-update-intro">
              <strong>发现新版本数据</strong>
              <span className="builtin-status-dim">{latestText}</span>
            </div>
            <p className="builtin-update-help">{copy.prepareHelp}</p>
            <div className="reference-version-actions">
              <button className="btn btn-primary" onClick={() => void prepare()}>{copy.prepare}</button>
            </div>
          </div>
        )}

        {/* 下载进度 */}
        {prepareActive && prepareJob && (
          <div className="builtin-update-panel is-downloading fade-in-soft" key="progress" aria-busy="true">
            <div className="builtin-update-progress-row">
              <span className="builtin-loading-grid is-progress" aria-hidden="true"><span /><span /><span /><span /></span>
              <div className="builtin-update-progress" role="progressbar" aria-label="数据集下载与准备进度" aria-valuenow={prepareJob.progress} aria-valuemin={0} aria-valuemax={100}>
                <div className="builtin-update-progress-fill" style={{ width: `${prepareJob.progress}%` }} />
              </div>
              <div className="builtin-update-progress-meta">
                <strong>{prepareJob.message}</strong>
                <span>{prepareJob.progress}%</span>
              </div>
              <button className="btn" onClick={() => void cancelJob()}>{copy.cancel}</button>
            </div>
          </div>
        )}

        {/* 模型选择 */}
        {catalogReady && status?.catalog && (
          <div className="builtin-update-panel fade-in-soft" key="catalog">
            <div className="builtin-catalog-head">
              <strong>选择要应用的模型</strong>
              <span className="builtin-status-dim">{status.catalog.qualified}/{status.catalog.total} 个合格 · 仅合格模型可选</span>
            </div>
            <p className="builtin-update-help">{existingPendingCount + newPendingCount > 0 ? copy.applyPending : "这份数据中可用的样本均已处理；检查到新的 Zenodo 版本后会再次显示。"}</p>

            {applyJob && (
              <div className={`builtin-operation-feedback is-${applyActive ? "running" : applyJob.status === "done" ? "latest" : "failed"}`} role={applyJob.status === "failed" ? "alert" : "status"} aria-live="polite" aria-busy={applyActive}>
                {applyActive && <span className="builtin-loading-grid is-progress" aria-hidden="true"><span /><span /><span /><span /></span>}
                <div>
                  <strong>{applyActive
                    ? (applyJob.action === "download" ? "正在下载新样本" : "正在更新内置样本")
                    : applyJob.status === "done"
                      ? (applyJob.action === "download" ? "新样本下载成功" : "内置样本更新成功")
                      : (applyJob.action === "download" ? "新样本下载失败" : "内置样本更新失败")}</strong>
                  <span>{applyJob.status === "failed" ? apiErrorMessage(applyJob.error ?? "处理失败。") : applyJob.message}</span>
                </div>
                {applyActive && (
                  <div className="builtin-operation-progress">
                    <div className="builtin-update-progress" role="progressbar" aria-label={applyJob.action === "download" ? "新样本下载进度" : "内置样本更新进度"} aria-valuenow={applyJob.progress} aria-valuemin={0} aria-valuemax={100}>
                      <div className="builtin-update-progress-fill" style={{ width: `${applyJob.progress}%` }} />
                    </div>
                    <strong>{applyJob.progress}%</strong>
                  </div>
                )}
                {applyJob.status === "failed" && <button className="btn btn-ghost" onClick={() => void applySelected(applyJob.modelIds ?? [], applyJob.action ?? "update")}>重试</button>}
              </div>
            )}
            {applyRequestFailure && (
              <div className="builtin-operation-feedback is-failed" role="alert">
                <div><strong>{applyRequestFailure.action === "download" ? "新样本下载失败" : "内置样本更新失败"}</strong><span>{applyRequestFailure.error}</span></div>
                <button className="btn btn-ghost" onClick={() => void applySelected(applyRequestFailure.modelIds, applyRequestFailure.action)}>重试</button>
              </div>
            )}
            {existingPendingCount === 0 && currentQualifiedModels.length > 0 && (
              <section className="builtin-group is-complete" aria-label="现有内置样本更新状态">
                <div className="builtin-group-head">
                  <strong>更新现有内置样本</strong>
                  <span className="builtin-status-dim">{currentAppliedCount}/{currentQualifiedModels.length} 已更新</span>
                </div>
                <input
                  className="builtin-search-input"
                  type="search"
                  value=""
                  placeholder="当前没有待更新的内置样本"
                  aria-label="搜索待更新的现有内置样本"
                  disabled
                />
                <div className="builtin-complete-state" role="status">
                  <span className="builtin-complete-mark" aria-hidden="true">✓</span>
                  <div>
                    <strong>现有内置样本已是最新版本</strong>
                    <p>检查到新的 Zenodo 版本后，可更新的模型会重新显示在这里。</p>
                    <div className="builtin-complete-meta">
                      <span>数据采集：{formatDate(status.current.collectedAt)}</span>
                      <span>入库更新：{formatDate(status.current.appliedAt)}</span>
                      <span>样本版本：{status.current.revision ? `v${status.current.revision}` : status.current.libraryVersion}</span>
                      {status.current.recordId ? <span>Zenodo record：{status.current.recordId}</span> : null}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {pendingBuiltinModels.length > 0 && (
              <section className="builtin-group">
                <div className="builtin-group-head">
                  <strong>更新现有内置样本</strong>
                  <span className="builtin-status-dim">
                    {selectedIn(pendingBuiltinModels)}/{pendingBuiltinModels.length} 已勾选
                    {trimmedBuiltinQuery ? ` · ${builtinModels.length} 个匹配` : ""}
                  </span>
                  <button className="btn btn-ghost" disabled={operationActive || builtinModels.length === 0} onClick={() => toggleGroup(builtinModels)}>
                    {builtinModels.length > 0 && builtinModels.every((model) => selected.has(model.model)) ? "清空匹配" : trimmedBuiltinQuery ? "全选匹配" : "全选更新"}
                  </button>
                </div>
                <input
                  className="builtin-search-input"
                  type="search"
                  value={builtinQuery}
                  placeholder="搜索待更新模型，如 gpt、claude、qwen"
                  aria-label="搜索待更新的现有内置样本"
                  onChange={(event) => setBuiltinQuery(event.target.value)}
                  spellCheck={false}
                />
                {builtinModels.length > 0 ? <div className="builtin-model-list">
                  {builtinModels.map((model) => (
                    <label key={model.model} className="builtin-model-row">
                      <input type="checkbox" checked={selected.has(model.model)} disabled={operationActive} onChange={() => toggleModel(model.model)} />
                      <span className="builtin-model-name">{model.model}</span>
                      <span className="tone-current">合格 · {model.nValid} 有效样本</span>
                    </label>
                  ))}
                </div> : <div className="builtin-status-dim builtin-empty-hint">没有匹配“{builtinQuery.trim()}”的待更新模型</div>}
                <div className="builtin-group-actions">
                  <button className="btn btn-primary" disabled={operationActive || selectedIn(pendingBuiltinModels) === 0} aria-busy={applyActive && applyJob?.action === "update"} onClick={() => void applySelected(selectedIdsIn(pendingBuiltinModels), "update")}>
                    {applyActive && applyJob?.action === "update" ? <><span className="builtin-loading-grid" aria-hidden="true"><span /><span /><span /><span /></span>更新中 {applyJob.progress}%</> : `更新内置样本（${selectedIn(pendingBuiltinModels)}）`}
                  </button>
                  <span className="builtin-status-dim">仅替换本区勾选的内置样本指纹，不影响其他模型。</span>
                </div>
              </section>
            )}

            {pendingNewModels.length > 0 && (
              <section className="builtin-group">
                <div className="builtin-group-head">
                  <strong>下载新样本（未内置）</strong>
                  <span className="builtin-status-dim">
                    {selectedIn(pendingNewModels)}/{pendingNewModels.length} 已勾选
                    {trimmedNewQuery ? ` · ${newModels.length} 个匹配` : ""}
                  </span>
                  <button className="btn btn-ghost" disabled={operationActive || newModels.length === 0} onClick={() => toggleGroup(newModels)}>
                    {newModels.length > 0 && newModels.every((model) => selected.has(model.model)) ? "清空匹配" : trimmedNewQuery ? "全选匹配" : "全选新增"}
                  </button>
                </div>
                <input
                  className="builtin-search-input"
                  type="search"
                  value={newQuery}
                  placeholder="搜索可下载模型，如 gpt、claude、qwen"
                  aria-label="搜索未内置的新样本"
                  onChange={(event) => setNewQuery(event.target.value)}
                  spellCheck={false}
                />
                {newModels.length > 0 ? <div className="builtin-model-list">
                  {newModels.map((model) => (
                    <label key={model.model} className="builtin-model-row">
                      <input type="checkbox" checked={selected.has(model.model)} disabled={operationActive} onChange={() => toggleModel(model.model)} />
                      <span className="builtin-model-name">{model.model}</span>
                      <span className="tone-usable">合格 · {model.nValid} 有效样本</span>
                    </label>
                  ))}
                </div> : <div className="builtin-status-dim builtin-empty-hint">没有匹配“{newQuery.trim()}”的可下载模型</div>}
                <div className="builtin-group-actions">
                  <button className="btn btn-primary" disabled={operationActive || selectedIn(pendingNewModels) === 0} aria-busy={applyActive && applyJob?.action === "download"} onClick={() => void applySelected(selectedIdsIn(pendingNewModels), "download")}>
                    {applyActive && applyJob?.action === "download" ? <><span className="builtin-loading-grid" aria-hidden="true"><span /><span /><span /><span /></span>下载中 {applyJob.progress}%</> : `下载新样本（${selectedIn(pendingNewModels)}）`}
                  </button>
                  <span className="builtin-status-dim">下载后同样成为内置参考（同 ID 替换新快照，可回滚）。</span>
                </div>
              </section>
            )}

            {showUnqualified && unqualifiedModels.length > 0 && (
              <section className="builtin-group">
                <div className="builtin-group-head">
                  <strong>不合格（不可应用）</strong>
                  <span className="builtin-status-dim">{unqualifiedModels.length} 个</span>
                </div>
                <div className="builtin-model-list">
                  {unqualifiedModels.map((model) => (
                    <div key={model.model} className="builtin-model-row is-disabled">
                      <span className="builtin-model-name">{model.model}</span>
                      <span className="tone-stale">不合格 · 缺 {model.missingCells} cell / 样本不足 {model.belowMinimumCells}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {unqualifiedCount > 0 && (
              <div className="builtin-list-footer">
                <span className="builtin-status-dim">{existingPendingCount + newPendingCount} 个待处理合格模型</span>
                <button className="btn btn-ghost" onClick={() => setShowUnqualified((current) => !current)}>
                  {showUnqualified ? "收起不合格" : `显示不合格（${unqualifiedCount}）`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 维护行（次要） */}
        <div className="builtin-meta-row">
          <span className="builtin-status-dim">
            {status ? `共 ${status.versions.length} 个版本 · 数据集缓存 ${formatBytes(status.cacheBytes)} / 2 GB` : ""}
          </span>
          <div className="reference-version-actions">
            <button className="btn btn-ghost" disabled={rollingBack || !canRollback || operationActive} onClick={() => void rollback()}>
              {rollingBack ? "回滚中…" : copy.rollback}
            </button>
            <button className="btn btn-ghost" disabled={cleaning || operationActive} onClick={() => void cleanCache()}>
              {cleaning ? "清理中…" : copy.cleanCache}
            </button>
          </div>
        </div>

        {/* 代理（折叠） */}
        <details className="builtin-proxy-details">
          <summary>
            {copy.proxyTitle} · {proxyInfo?.configured
              ? `${proxyInfo.host}${proxyInfo.hasAuth ? "（含认证）" : ""}`
              : "未配置（直连）"}
          </summary>
          <p className="builtin-update-help">{copy.proxyHelp}</p>
          <div className="reference-version-actions">
            <input
              className="builtin-proxy-input"
              type="text"
              value={proxyInput}
              placeholder={copy.proxyPlaceholder}
              onChange={(event) => setProxyInput(event.target.value)}
              spellCheck={false}
            />
            <button className="btn btn-primary" onClick={() => void saveProxy()} disabled={!proxyInput.trim()}>
              {copy.proxySet}
            </button>
            <button className="btn" onClick={() => void clearProxy()} disabled={!proxyInfo?.configured}>
              {copy.proxyClear}
            </button>
            <button className="btn" onClick={() => void testProxy()} disabled={proxyTesting}>
              {proxyTesting ? "测试中…" : copy.proxyTest}
            </button>
          </div>
          {proxyTest && <div className={`connection-inline fade-in-soft ${proxyTest.startsWith(copy.proxyTestOk) ? "is-success" : "is-failed"}`} role="status">{proxyTest}</div>}
        </details>
      </div>
    </section>
  );
}

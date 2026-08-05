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
  const [query, setQuery] = useState("");
  const [showUnqualified, setShowUnqualified] = useState(false);
  const [applying, setApplying] = useState(false);
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
    };
  }, []);

  const pollJob = (jobId: string) => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      try {
        const job = await api.builtinLibraryUpdateJob(jobId);
        setStatus((current) => (current ? { ...current, prepareJob: job } : current));
        if (job.status === "done" || job.status === "failed" || job.status === "canceled") {
          if (timer.current) window.clearInterval(timer.current);
          if (job.status === "done") { setNotice(copy.prepareDone); await load(true); }
          else if (job.status === "failed") setError(job.error ?? "数据集准备失败。");
          else setNotice("已取消数据集下载。");
        }
      } catch {
        if (timer.current) window.clearInterval(timer.current);
      }
    }, 1200);
  };

  const check = async () => {
    setChecking(true);
    setNotice("");
    try {
      const next = await api.builtinLibraryUpdateCheck(true);
      setStatus(next);
      setError("");
      if (next.lastError) setError(next.lastError);
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
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

  const applySelected = async (modelIds: string[]) => {
    const ids = [...modelIds].sort((a, b) => a.localeCompare(b));
    if (!ids.length) { setError("请先勾选要更新的模型。"); return; }
    setApplying(true);
    setError("");
    try {
      const next = await api.builtinLibraryUpdateApply(ids);
      setStatus(next);
      setSelected(new Set());
      setNotice(`已更新为内置参考（${ids.length} 个模型）。`);
      onLibraryChanged?.();
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
    } finally {
      setApplying(false);
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
      for (const model of builtinModels) next.add(model.model);
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
  const trimmedQuery = query.trim().toLowerCase();
  const filteredModels = trimmedQuery
    ? catalogModels.filter((model) => model.model.toLowerCase().includes(trimmedQuery))
    : catalogModels;
  const currentBuiltinIds = new Set(status?.current.modelIds ?? []);
  const builtinModels = filteredModels.filter((model) => model.qualified && currentBuiltinIds.has(model.model));
  const newModels = filteredModels.filter((model) => model.qualified && !currentBuiltinIds.has(model.model));
  const unqualifiedModels = filteredModels.filter((model) => !model.qualified);
  const selectedIn = (models: typeof catalogModels) => models.filter((model) => selected.has(model.model)).length;
  const selectedIdsIn = (models: typeof catalogModels) => models.filter((model) => selected.has(model.model)).map((model) => model.model);
  const catalogApplied = Boolean(status?.catalog.recordId && status.current.recordId === status.catalog.recordId);
  const catalogReady = Boolean(status?.catalog.ready && status.catalog.models.length);

  // Auto-select the current built-in models that are present and qualified in the
  // downloaded dataset, so “refresh my existing samples” does not need per-model clicks.
  useEffect(() => {
    if (catalogReady && !catalogApplied && selected.size === 0 && builtinModels.length > 0) {
      selectCurrentBuiltin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogReady, catalogApplied, status?.catalog.recordId, status?.catalog.total]);
  const job = status?.prepareJob;
  const jobActive = Boolean(job && (job.status === "queued" || job.status === "running"));
  const canRollback = (status?.versions.length ?? 0) > 1;
  const hasChecked = Boolean(status?.latest);

  const phase: Phase = checking
    ? "checking"
    : jobActive
      ? "downloading"
      : status?.lastError
        ? "error"
        : catalogReady
          ? "catalog"
          : status?.updateAvailable
            ? "update_available"
            : hasChecked
              ? "up_to_date"
              : "idle";

  const latestText = status?.latest
    ? `${status.latest.version ?? "（未标注版本）"} · 更新 ${formatDate(status.latest.updated)}`
    : "";
  const currentText = status ? `${status.current.libraryVersion} · ${status.current.models} 模型` : "加载中…";
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
          <button className="btn btn-primary" disabled={checking || jobActive} onClick={() => void check()}>
            {checking ? "检查中…" : (hasChecked ? copy.refresh : copy.check)}
          </button>
        </div>

        {error && <div className="connection-inline is-failed fade-in-soft" role="alert">{error}</div>}
        {notice && <div className="connection-inline is-success fade-in-soft" role="status">{notice}</div>}

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

        {/* 发现新版本 -> 下载准备 */}
        {status?.updateAvailable && !catalogReady && !jobActive && (
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
        {jobActive && job && (
          <div className="builtin-update-panel is-downloading fade-in-soft" key="progress">
            <div className="builtin-update-progress-row">
              <div className="builtin-update-progress" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100}>
                <div className="builtin-update-progress-fill" style={{ width: `${job.progress}%` }} />
              </div>
              <div className="builtin-update-progress-meta">
                <strong>{job.message}</strong>
                <span>{job.progress}%</span>
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
            <p className="builtin-update-help">{catalogApplied ? copy.applyCurrent : copy.applyPending}</p>
            <input
              className="builtin-search-input"
              type="text"
              value={query}
              placeholder="搜索模型，如 gpt、claude、qwen"
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
            />
            {builtinModels.length > 0 && (
              <section className="builtin-group">
                <div className="builtin-group-head">
                  <strong>更新现有内置样本</strong>
                  <span className="builtin-status-dim">{selectedIn(builtinModels)}/{builtinModels.length} 已勾选</span>
                  <button className="btn btn-ghost" disabled={applying} onClick={() => toggleGroup(builtinModels)}>
                    {builtinModels.every((model) => selected.has(model.model)) ? "清空" : "全选更新"}
                  </button>
                </div>
                <div className="builtin-model-list">
                  {builtinModels.map((model) => (
                    <label key={model.model} className="builtin-model-row">
                      <input type="checkbox" checked={selected.has(model.model)} disabled={applying} onChange={() => toggleModel(model.model)} />
                      <span className="builtin-model-name">{model.model}</span>
                      <span className="tone-current">合格 · {model.nValid} 有效样本</span>
                    </label>
                  ))}
                </div>
                <div className="builtin-group-actions">
                  <button className="btn btn-primary" disabled={applying || selectedIn(builtinModels) === 0} onClick={() => void applySelected(selectedIdsIn(builtinModels))}>
                    {applying ? "处理中…" : `更新内置样本（${selectedIn(builtinModels)}）`}
                  </button>
                  <span className="builtin-status-dim">仅替换本区勾选的内置样本指纹，不影响其他模型。</span>
                </div>
              </section>
            )}

            {newModels.length > 0 && (
              <section className="builtin-group">
                <div className="builtin-group-head">
                  <strong>下载新样本（未内置）</strong>
                  <span className="builtin-status-dim">{selectedIn(newModels)}/{newModels.length} 已勾选</span>
                  <button className="btn btn-ghost" disabled={applying} onClick={() => toggleGroup(newModels)}>
                    {newModels.every((model) => selected.has(model.model)) ? "清空" : "全选新增"}
                  </button>
                </div>
                <div className="builtin-model-list">
                  {newModels.map((model) => (
                    <label key={model.model} className="builtin-model-row">
                      <input type="checkbox" checked={selected.has(model.model)} disabled={applying} onChange={() => toggleModel(model.model)} />
                      <span className="builtin-model-name">{model.model}</span>
                      <span className="tone-usable">合格 · {model.nValid} 有效样本</span>
                    </label>
                  ))}
                </div>
                <div className="builtin-group-actions">
                  <button className="btn btn-primary" disabled={applying || selectedIn(newModels) === 0} onClick={() => void applySelected(selectedIdsIn(newModels))}>
                    {applying ? "处理中…" : `下载新样本（${selectedIn(newModels)}）`}
                  </button>
                  <span className="builtin-status-dim">下载后同样成为内置参考（同 ID 替换新快照，可回滚）。</span>
                </div>
              </section>
            )}

            {showUnqualified && unqualifiedModels.length > 0 && (
              <section className="builtin-group">
                <div className="builtin-group-head">
                  <strong>不合格（不可应用）</strong>
                  <span className="builtin-status-dim">{trimmedQuery ? `${unqualifiedModels.length} 个匹配` : `${unqualifiedModels.length} 个`}</span>
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

            {trimmedQuery && builtinModels.length + newModels.length === 0 && (
              <div className="builtin-status-dim builtin-empty-hint">没有匹配“{query.trim()}”的模型</div>
            )}

            {unqualifiedCount > 0 && (
              <div className="builtin-list-footer">
                <span className="builtin-status-dim">
                  {trimmedQuery ? `${builtinModels.length + newModels.length} 个匹配` : `${builtinModels.length + newModels.length} 个合格模型`}
                </span>
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
            <button className="btn btn-ghost" disabled={rollingBack || !canRollback || jobActive} onClick={() => void rollback()}>
              {rollingBack ? "回滚中…" : copy.rollback}
            </button>
            <button className="btn btn-ghost" disabled={cleaning || jobActive} onClick={() => void cleanCache()}>
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

import { useEffect, useRef, useState } from "react";
import { api, type ApiZenodoUpdateStatus } from "./api";
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

/**
 * 内置研究参考更新面板：检查 Zenodo 新版本 -> 下载并准备数据集 -> 勾选
 * 模型更新运行时内置库；保留最近 3 个版本可回滚，数据集缓存一键清理。
 */
export function V2BuiltinLibraryUpdate({ onLibraryChanged }: { onLibraryChanged?: () => void }) {
  const [status, setStatus] = useState<ApiZenodoUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const timer = useRef<number | null>(null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setStatus(await api.builtinLibraryUpdateStatus());
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
          setNotice(job.status === "done" ? copy.prepareDone : job.error ?? "");
          await load(true);
        }
      } catch {
        if (timer.current) window.clearInterval(timer.current);
      }
    }, 1500);
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
    try {
      const job = await api.builtinLibraryUpdatePrepare();
      setStatus((current) => (current ? { ...current, prepareJob: job } : current));
      pollJob(job.id);
    } catch (value) {
      setError(apiErrorMessage(value instanceof Error ? value.message : String(value)));
    }
  };

  const applySelected = async () => {
    const modelIds = [...selected].sort((a, b) => a.localeCompare(b));
    if (!modelIds.length) { setError("请先勾选要更新的模型。"); return; }
    setApplying(true);
    setError("");
    try {
      const next = await api.builtinLibraryUpdateApply(modelIds);
      setStatus(next);
      setSelected(new Set());
      setNotice(`已更新 ${modelIds.length} 个模型。`);
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

  const selectAllQualified = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const model of status?.catalog.models ?? []) if (model.qualified) next.add(model.model);
      return next;
    });
  };

  const job = status?.prepareJob;
  const jobActive = Boolean(job && (job.status === "queued" || job.status === "running"));
  const catalogReady = Boolean(status?.catalog.ready && status.catalog.models.length);
  const canRollback = (status?.versions.length ?? 0) > 1;

  return (
    <section className="reference-group builtin-update-group">
      <div className="card reference-overview-card">
        <div className="section-heading">
          <h2 className="section-title">{copy.title}</h2>
        </div>
        <p className="reference-help">{copy.help}</p>

        {error && <div className="connection-inline is-failed" role="alert">{error}</div>}
        {notice && <div className="connection-inline is-success" role="status">{notice}</div>}

        <div className="reference-overview-header">
          <div className="reference-overview-copy">
            <span className="reference-kicker">当前内置库</span>
            {status ? (
              <div className="reference-status-detail">
                <div className="reference-status-badges">
                  <span className={`tone-${status.current.source === "runtime" ? "usable" : "current"}`}>
                    {status.current.source === "runtime" ? copy.runtime : copy.bundled}
                  </span>
                  <span>{status.current.libraryVersion}</span>
                  <span>{status.current.models} 个模型</span>
                  <span>采集 {formatDate(status.current.collectedAt)}</span>
                </div>
              </div>
            ) : (
              <div className="reference-status-detail">{loading ? "加载中…" : "无法获取状态"}</div>
            )}

            <span className="reference-kicker">{copy.latest}</span>
            {status?.latest ? (
              <div className="reference-status-detail">
                <div className="reference-status-badges">
                  <span className={`tone-${status.updateAvailable ? "review_required" : "current"}`}>
                    {status.updateAvailable ? copy.updateAvailable : copy.upToDate}
                  </span>
                  <span>{status.latest.version ?? "（未标注版本）"}</span>
                  <span>更新 {formatDate(status.latest.updated)}</span>
                </div>
              </div>
            ) : (
              <div className="reference-status-detail">
                {loading ? "加载中…" : copy.notChecked}
                {status?.lastError && <span>（{status.lastError}）</span>}
              </div>
            )}
          </div>
          <div className="reference-overview-action">
            <button className="btn btn-primary" disabled={checking || jobActive} onClick={() => void check()}>
              {checking ? "检查中…" : (status?.latest ? copy.refresh : copy.check)}
            </button>
          </div>
        </div>

        {status?.updateAvailable && (
          <div className="reference-version-panel">
            <div className="reference-version-heading">
              <strong>准备新数据集</strong>
              <span className="reference-version-meta">
                下载一次并缓存（上限 2 GB），之后按模型选择更新，无需重复下载。
              </span>
            </div>
            <div className="reference-version-actions">
              {!catalogReady && (
                <button className="btn btn-primary" disabled={jobActive} onClick={() => void prepare()}>
                  {copy.prepare}
                </button>
              )}
              {jobActive && job && (
                <>
                  <button className="btn" disabled={!jobActive} onClick={() => void api.builtinLibraryUpdateCancelJob(job.id).then(() => load(true)).catch(() => undefined)}>
                    {copy.cancel}
                  </button>
                  <div className="reference-progress" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100}>
                    <div className="reference-progress-fill" style={{ width: `${job.progress}%` }} />
                    <span className="reference-progress-label">{job.message} · {job.progress}%</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {catalogReady && status?.catalog && (
          <div className="reference-version-panel">
            <div className="reference-version-heading">
              <strong>选择要更新的模型</strong>
              <span className="reference-version-meta">
                {copy.selectHandled}（{status.catalog.qualified}/{status.catalog.total} 合格）。
              </span>
            </div>
            <div className="builtin-model-list">
              {status.catalog.models.map((model) => (
                <label key={model.model} className={`builtin-model-row ${model.qualified ? "" : "is-disabled"}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(model.model)}
                    disabled={!model.qualified || applying}
                    onChange={() => toggleModel(model.model)}
                  />
                  <span className="builtin-model-name">{model.model}</span>
                  {model.qualified
                    ? <span className="tone-current">合格 · {model.nValid} 有效样本</span>
                    : <span className="tone-stale">不合格 · 缺 {model.missingCells} cell / 样本不足 {model.belowMinimumCells}</span>}
                </label>
              ))}
            </div>
            <div className="reference-version-actions">
              <button className="btn" disabled={applying || !selected.size} onClick={selectAllQualified}>
                全选合格模型
              </button>
              <button className="btn btn-primary" disabled={applying || !selected.size} onClick={() => void applySelected()}>
                {applying ? "更新中…" : `${copy.apply}（${selected.size}）`}
              </button>
            </div>
          </div>
        )}

        <div className="reference-overview-header">
          <div className="reference-overview-copy">
            <span className="reference-kicker">版本历史与维护</span>
            <div className="reference-status-detail">
              <div className="reference-status-badges">
                <span>{status ? `${status.versions.length} 个版本` : "…"}</span>
                <span>数据集缓存 {status ? formatBytes(status.cacheBytes) : "…"} / 上限 2 GB</span>
              </div>
              {status && status.versions.length > 0 && (
                <ul className="builtin-version-list">
                  {[...status.versions].reverse().map((version) => (
                    <li key={version.file}>
                      <code>{version.file}</code> · {version.libraryVersion} · {version.modelIds} 个模型 · {formatDate(version.appliedAt)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="reference-overview-action reference-version-actions">
            <button className="btn" disabled={rollingBack || !canRollback || jobActive} onClick={() => void rollback()}>
              {rollingBack ? "回滚中…" : copy.rollback}
            </button>
            <button className="btn" disabled={cleaning || jobActive} onClick={() => void cleanCache()}>
              {cleaning ? "清理中…" : copy.cleanCache}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

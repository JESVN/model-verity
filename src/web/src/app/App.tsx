import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppShell, ConfirmDialog, LoadingState, Select, TrashIcon, V2ResultPanel } from "@ui/index";
import type { NavId } from "@ui/types";
import { api, type ApiConnectionTest, type ApiProtocol, type ApiProvider, type ApiReference } from "./api";
import { V2Workspace } from "./V2Workspace";
import { V2ReferenceGovernance } from "./V2ReferenceGovernance";
import { scorecardPresentation } from "../../../core/v3/presentation";
import { MODEL_ID_HELP, PROTOCOL_OPTIONS, PROVIDER_ROLE_OPTIONS, connectionCategoryLabel, protocolHelp, protocolLabel, providerRoleLabel, runStatusLabel, verificationModeLabel } from "./terminology";


interface DeleteRequest {
  title: string;
  description: ReactNode;
  action: () => Promise<void>;
  blocked?: boolean;
}

type ProviderForm = {
  id: string;
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  models: string;
  role: "reference" | "audit" | "either";
};

export function App() {
  const [activeNav,setActiveNav]=useState<NavId>("verify");
  const [providers,setProviders]=useState<ApiProvider[]>([]);
  const [references,setReferences]=useState<ApiReference[]>([]);
  const [history,setHistory]=useState<any[]>([]);
  const [selectedRun,setSelectedRun]=useState<any|null>(null);
  const [selectedHistoryRun,setSelectedHistoryRun]=useState<any|null>(null);
  const [retryRun,setRetryRun]=useState<any|null>(null);
  const [activeReferenceRun,setActiveReferenceRun]=useState<any|null>(null);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(true);
  const [maintenance,setMaintenance]=useState(false);
  const [deleteRequest,setDeleteRequest]=useState<DeleteRequest|null>(null);
  const [deleteBusy,setDeleteBusy]=useState(false);
  const [deleteError,setDeleteError]=useState("");
  const mainRef=useRef<HTMLElement|null>(null);

  const refresh=useCallback(async()=>{
    try{
      const {providers: providerItems,references: referenceItems,runs: runItems,status}=await api.bootstrap();
      setProviders(providerItems);setReferences(referenceItems);setHistory(runItems);setMaintenance(status.maintenance);setError("");
      setSelectedRun((current:any)=>current?runItems.find((item)=>item.id===current.id)??null:current);
      setSelectedHistoryRun((current:any)=>current?runItems.find((item)=>item.id===current.id)??null:current);
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);

  const requestV2RunDelete=useCallback((run:any)=>{setDeleteError("");setDeleteRequest({title:"删除这条验证记录？",description:<><p>该记录及其样本、证据和分享报告将永久删除，无法撤销。</p><p className="caption-muted">共享参考样本不会删除。</p></>,action:async()=>{await api.deleteV2Run(run.id);setSelectedRun((current:any)=>current?.id===run.id?null:current);setSelectedHistoryRun((current:any)=>current?.id===run.id?null:current);}});},[]);
  const requestProviderDelete=useCallback(async(provider:ApiProvider)=>{try{const usage=await api.providerUsage(provider.id);setDeleteError("");setDeleteRequest({title:`删除供应商“${provider.name}”？`,description:<><p><strong>{provider.baseUrl}</strong></p><p>供应商配置和加密 API Key 将永久删除；已有 {usage.historyRuns} 条历史记录会保留。</p>{usage.references?<p className="dialog-blocked">该供应商仍有 {usage.references} 个本地参考，请先删除参考。</p>:null}{usage.activeRuns?<p className="dialog-blocked">该供应商有进行中的任务，当前不能删除。</p>:null}</>,blocked:Boolean(usage.references||usage.activeRuns),action:async()=>{await api.deleteProvider(provider.id);}});}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}},[]);
  const confirmDelete=useCallback(async()=>{if(!deleteRequest||deleteRequest.blocked)return;setDeleteBusy(true);setDeleteError("");try{await deleteRequest.action();setDeleteRequest(null);await refresh();}catch(cause){setDeleteError(cause instanceof Error?cause.message:String(cause));}finally{setDeleteBusy(false);}},[deleteRequest,refresh]);

  const openSection=useCallback((nav:NavId)=>{setActiveNav(nav);setSelectedHistoryRun(null);mainRef.current?.scrollTo({top:0});},[]);
  const openHistoryRun=useCallback((run:any)=>{setSelectedHistoryRun(run);setActiveNav("history");mainRef.current?.scrollTo({top:0});},[]);
  const returnToHistory=useCallback(()=>{setSelectedHistoryRun(null);mainRef.current?.scrollTo({top:0});},[]);
  const verifyAgain=useCallback((run:any)=>{setRetryRun(run);setSelectedHistoryRun(null);setSelectedRun(null);setActiveNav("verify");mainRef.current?.scrollTo({top:0});},[]);
  const openReferences=useCallback(()=>{setSelectedHistoryRun(null);setActiveNav("references");mainRef.current?.scrollTo({top:0});},[]);
  const activeVerification=selectedRun?.mode!=="reference_enrollment"&&["queued","running"].includes(selectedRun?.status)?selectedRun:history.find((run)=>run.mode!=="reference_enrollment"&&["queued","running"].includes(run.status));
  const activeReference=activeReferenceRun?.mode==="reference_enrollment"&&["queued","running"].includes(activeReferenceRun?.status)?activeReferenceRun:history.find((run)=>run.mode==="reference_enrollment"&&["queued","running"].includes(run.status));
  const navProgress=(run:any)=>run?{label:`${Math.max(0,Math.min(100,Math.round(Number(run.progress??0)*100)))}%`,tone:"running" as const}:undefined;
  const navStatus={verify:navProgress(activeVerification),references:navProgress(activeReference)};

  return <AppShell activeNav={activeNav} onNav={openSection} mainRef={mainRef} navStatus={navStatus} topRight={<span>{loading?"正在同步数据":maintenance?"维护中":"服务已连接"}</span>}>
    {loading?<LoadingState label="正在加载验证数据" detail="同步供应商、参考样本和历史记录"/>:<>
    {maintenance?<div className="maintenance-notice" role="status">系统正在更新，暂时不能启动新任务或删除供应商；现有任务不受影响。</div>:null}
    {error?<div className="notice-error" role="alert">{error}</div>:null}
    <section hidden={activeNav!=="verify"} aria-hidden={activeNav!=="verify"}>
      <V2Workspace providers={providers} references={references} initialRun={selectedRun} retryRun={retryRun} onRetryApplied={()=>setRetryRun(null)} onRunChanged={(value)=>{setSelectedRun(value);if(value&&!history.some((item)=>item.id===value.id))void refresh();}}/>
    </section>
    <section hidden={activeNav!=="providers"} aria-hidden={activeNav!=="providers"}>
      <ProviderManager items={providers} onChanged={refresh} onDelete={requestProviderDelete} taskActive={history.some((run)=>["queued","running"].includes(run.status))} maintenance={maintenance}/>
    </section>
    <section hidden={activeNav!=="references"} aria-hidden={activeNav!=="references"}>
      <ReferenceManager providers={providers} items={references} onChanged={refresh} onV2RunChanged={(run)=>{setActiveReferenceRun(run);if(run&&!history.some((item)=>item.id===run.id))void refresh();}}/>
    </section>
    <section hidden={activeNav!=="history"} aria-hidden={activeNav!=="history"}>
      {selectedHistoryRun?<HistoryRunDetail run={selectedHistoryRun} onBack={returnToHistory} onVerifyAgain={verifyAgain} onOpenReferences={openReferences}/>:<HistoryPreview v2Items={history} providers={providers} onOpenV2={openHistoryRun} requestV2Delete={requestV2RunDelete}/>} 
    </section>
    <ConfirmDialog open={Boolean(deleteRequest)} title={deleteRequest?.title??"确认删除"} description={deleteRequest?.description} busy={deleteBusy} confirmDisabled={deleteRequest?.blocked} error={deleteError} onCancel={()=>{if(!deleteBusy){setDeleteRequest(null);setDeleteError("");}}} onConfirm={()=>void confirmDelete()}/>
    </>}
  </AppShell>;
}

function ProviderManager({ items, onChanged, onDelete, taskActive, maintenance }: { items: ApiProvider[]; onChanged: () => Promise<void>; onDelete: (provider: ApiProvider) => void; taskActive: boolean; maintenance: boolean }) {
  const empty: ProviderForm = { id: "", name: "", protocol: "openai-compatible", baseUrl: "", apiKey: "", models: "", role: "audit" };
  const [form, setForm] = useState<ProviderForm>(empty);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [discoveredModel, setDiscoveredModel] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<ApiProvider | null>(null);
  const [testProvider, setTestProvider] = useState<ApiProvider | null>(null);
  const [testModel, setTestModel] = useState("");
  const [testProtocol, setTestProtocol] = useState<ApiProtocol>("openai-compatible");
  const [testSession, setTestSession] = useState<ApiConnectionTest | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ApiConnectionTest>>({});
  const testPollRef = useRef<number | null>(null);
  const configuredModels = useMemo(
    () => [...new Set(form.models.split(",").map((value) => value.trim()).filter(Boolean))],
    [form.models],
  );
  const reset = () => { setForm(empty); setDiscoveredModels([]); setDiscoveredModel(""); };
  const submit = async () => {
    setBusy(true); setMessage("");
    try {
      await api.saveProvider({ ...form, id: form.id || undefined, models: configuredModels });
      if (form.id) { closeEdit(); }
      else { reset(); setMessage("供应商已保存"); }
      await onChanged();
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const discover = async () => {
    setDiscovering(true); setMessage(""); setDiscoveredModels([]); setDiscoveredModel("");
    try {
      const found = await api.discoverModels({ providerId: form.id || undefined, protocol: form.protocol, baseUrl: form.baseUrl, apiKey: form.apiKey || undefined });
      setDiscoveredModels(found);
      setMessage(found.length ? `已获取 ${found.length} 个模型。请选择要加入的模型。` : "接口返回成功，但没有可识别的模型 ID。你仍可手动填写。");
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setDiscovering(false); }
  };
  const addDiscoveredModel = (model: string) => {
    setDiscoveredModel(model);
    if (!model || configuredModels.includes(model)) return;
    setForm((current) => ({ ...current, models: [...configuredModels, model].join(", ") }));
    setMessage(`已加入 ${model}；保存供应商后生效。`);
  };
  const edit = (item: ApiProvider) => {
    setEditing(item);
    setForm({ id: item.id, name: item.name, protocol: item.protocol, baseUrl: item.baseUrl, apiKey: "", models: item.models.join(", "), role: item.role });
    setDiscoveredModels([]); setDiscoveredModel(""); setMessage("");
  };
  const closeEdit = () => { setEditing(null); setForm(empty); setDiscoveredModels([]); setDiscoveredModel(""); setMessage(""); };
  const canDiscover = Boolean(form.baseUrl && (form.apiKey || form.id));
  const openTest = (provider: ApiProvider) => { setTestProvider(provider); setTestModel(provider.models[0] ?? ""); setTestProtocol(provider.protocol); setTestSession(null); };
  const pollTest = async (id: string) => {
    try {
      const session = await api.connectionTest(id); setTestSession(session);
      if (session.status === "running") testPollRef.current = window.setTimeout(() => void pollTest(id), 400);
      else { testPollRef.current = null; setTestResults((current) => ({ ...current, [session.providerId]: session })); }
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); testPollRef.current = null; }
  };
  const startTest = async () => {
    if (!testProvider || !testModel) return;
    try { const session = await api.startConnectionTest(testProvider.id, testModel, testProtocol); setTestSession(session); void pollTest(session.id); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
  };
  const closeTest = async () => {
    if (testSession?.status === "running") {
      if (!window.confirm("测试正在进行，关闭将取消请求。是否继续？")) return;
      try { await api.cancelConnectionTest(testSession.id); } catch { /* session may already have finished */ }
    }
    if (testPollRef.current) window.clearTimeout(testPollRef.current); testPollRef.current = null; setTestProvider(null); setTestSession(null);
  };
  return <div className="fade-in"><h1 className="page-title">供应商</h1><p className="page-sub">保存 API 服务，并设置它用于验证还是参考。API Key 加密保存。</p>
    <section className="card manage-card"><div className="manage-grid">
      <Field label="名称" value={form.name} onChange={(name) => setForm({ ...form, name })} help="仅供识别，不会发送给供应商。" />
      <Field label="API 基础地址（Base URL）" value={form.baseUrl} onChange={(baseUrl) => { setForm({ ...form, baseUrl }); setDiscoveredModels([]); setDiscoveredModel(""); }} placeholder="https://api.example.com/v1" help="填写服务文档中的 API 根地址；填错会连接失败。" />
      <Field label={form.id ? "API Key（留空则不更改）" : "API Key"} value={form.apiKey} onChange={(apiKey) => setForm({ ...form, apiKey })} type="password" help="用于 API 鉴权并加密保存；编辑时留空可保留原密钥。" />
      <SelectField label="默认请求协议" value={form.protocol} onChange={(protocol) => { setForm({ ...form, protocol: protocol as ApiProtocol }); setDiscoveredModels([]); setDiscoveredModel(""); }} options={PROTOCOL_OPTIONS.map((item)=>[item.value,item.label,item.description])} help={protocolHelp(form.protocol as ApiProtocol)} />
      <SelectField label="可用角色" value={form.role} onChange={(role) => setForm({ ...form, role: role as ProviderForm["role"] })} options={PROVIDER_ROLE_OPTIONS.map((item)=>[item.value,item.label,item.description])} help={PROVIDER_ROLE_OPTIONS.find((item)=>item.value===form.role)?.description} />
      <div className="field model-id-field">
        <label htmlFor="provider-model-ids">模型 ID</label>
        <input id="provider-model-ids" value={form.models} placeholder="手动填写，多个 ID 用逗号分隔" onChange={(event) => setForm({ ...form, models: event.target.value })} />
        <span className="caption-muted">已配置 {configuredModels.length} 个。{MODEL_ID_HELP} 可手填，也可从模型列表加入。</span>
      </div>
      <div className="field model-discovery-field">
        <label htmlFor="discovered-model">从模型列表接口获取</label>
        <div className="model-discovery-row">
          <button type="button" className="btn btn-secondary" disabled={discovering || !canDiscover} onClick={() => void discover()}>{discovering ? "获取中…" : "获取模型列表"}</button>
          <Select
            id="discovered-model"
            value={discoveredModel}
            disabled={!discoveredModels.length}
            searchable
            searchPlaceholder="搜索远程模型 ID"
            placeholder={discoveredModels.length ? `选择模型（${discoveredModels.length}）` : "获取后选择"}
            options={discoveredModels.map((model) => ({ value: model, label: model, badge: configuredModels.includes(model) ? "已加入" : undefined, badgeTone: "neutral" }))}
            onChange={addDiscoveredModel}
          />
        </div>
        <span className="caption-muted">按当前协议读取模型列表。列表只表示服务声称支持这些 ID，不证明模型身份。</span>
      </div>
    </div><button className="btn btn-primary" disabled={busy || !form.name || !form.baseUrl || (!form.id && !form.apiKey) || !configuredModels.length} onClick={() => void submit()}>{busy ? "保存中…" : form.id ? "保存修改" : "添加供应商"}</button>{message ? <span className="caption manage-message" role="status">{message}</span> : null}</section>
    <div className="list manage-list provider-list">{items.map((item) => { const tested = testResults[item.id]; return <div className="list-item" key={item.id}><div><div className="list-item-title">{item.name}</div><div className="list-item-sub">协议：{protocolLabel(item.protocol)} · 地址：{item.baseUrl}<br />密钥：{item.keyMasked}（{item.secretBackend==="keychain"?"系统钥匙串":"本机加密文件"}） · 用途：{providerRoleLabel(item.role)} · 模型：{item.models.join(", ")}</div>{tested ? <div className={`connection-inline ${tested.status === "succeeded" ? "is-success" : "is-failed"}`}>{tested.status === "succeeded" ? "最近测试成功" : "最近测试失败"} · {tested.model}{tested.result?.latencyMs != null ? ` · ${Math.round(tested.result.latencyMs)} ms` : ""} · {new Date(tested.finishedAt ?? tested.createdAt).toLocaleTimeString()}<br /><span>仅代表当时可连接，不证明模型身份。</span></div> : null}</div><div className="btn-row compact provider-actions"><button className="btn btn-secondary" disabled={taskActive || maintenance || testSession?.status === "running"} title={taskActive ? "采样期间不可测试连接，以免影响验证结果" : undefined} onClick={() => openTest(item)}>测试连接</button><button className="btn btn-ghost" disabled={testSession?.status === "running" && testProvider?.id === item.id} onClick={() => edit(item)}>编辑</button><button className="icon-btn danger" aria-label={`删除供应商 ${item.name}`} title="删除供应商" disabled={maintenance || (testSession?.status === "running" && testProvider?.id === item.id)} onClick={() => onDelete(item)}><TrashIcon /></button></div></div>; })}</div>
    {editing ? <ProviderEditDialog key={editing.id} provider={editing} busy={busy} form={form} configuredModels={configuredModels} discovering={discovering} discoveredModels={discoveredModels} discoveredModel={discoveredModel} canDiscover={canDiscover} message={message} onForm={setForm} onDiscover={() => void discover()} onAddDiscoveredModel={addDiscoveredModel} onSubmit={() => void submit()} onClose={closeEdit} /> : null}
    {testProvider ? <ConnectionTestDialog provider={testProvider} model={testModel} protocol={testProtocol} session={testSession} onModel={setTestModel} onProtocol={setTestProtocol} onStart={() => void startTest()} onClose={() => void closeTest()} /> : null}
  </div>;
}

function ProviderEditDialog({ provider, busy, form, configuredModels, discovering, discoveredModels, discoveredModel, canDiscover, message, onForm, onDiscover, onAddDiscoveredModel, onSubmit, onClose }: {
  provider: ApiProvider;
  busy: boolean;
  form: ProviderForm;
  configuredModels: string[];
  discovering: boolean;
  discoveredModels: string[];
  discoveredModel: string;
  canDiscover: boolean;
  message: string;
  onForm: (form: ProviderForm) => void;
  onDiscover: () => void;
  onAddDiscoveredModel: (model: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<ProviderForm>) => onForm({ ...form, ...patch });
  return <div className="dialog-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog-card provider-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-edit-title"><h2 id="provider-edit-title">编辑供应商</h2><p className="dialog-description"><strong>{provider.name}</strong><br />{provider.baseUrl}</p><div className="manage-grid">
      <Field label="名称" value={form.name} onChange={(name) => set({ name })} help="仅供识别，不会发送给供应商。" />
      <Field label="API 基础地址（Base URL）" value={form.baseUrl} onChange={(baseUrl) => { set({ baseUrl }); }} placeholder="https://api.example.com/v1" help="填写服务文档中的 API 根地址；填错会连接失败。" />
      <Field label="API Key（留空则不更改）" value={form.apiKey} onChange={(apiKey) => set({ apiKey })} type="password" help="用于 API 鉴权并加密保存；编辑时留空可保留原密钥，也可直接用已保存密钥获取模型。" />
      <SelectField label="默认请求协议" value={form.protocol} onChange={(protocol) => set({ protocol: protocol as ApiProtocol })} options={PROTOCOL_OPTIONS.map((item)=>[item.value,item.label,item.description])} help={protocolHelp(form.protocol as ApiProtocol)} />
      <SelectField label="可用角色" value={form.role} onChange={(role) => set({ role: role as ProviderForm["role"] })} options={PROVIDER_ROLE_OPTIONS.map((item)=>[item.value,item.label,item.description])} help={PROVIDER_ROLE_OPTIONS.find((item)=>item.value===form.role)?.description} />
      <div className="field model-id-field">
        <label htmlFor="provider-edit-model-ids">模型 ID</label>
        <input id="provider-edit-model-ids" value={form.models} placeholder="手动填写，多个 ID 用逗号分隔" onChange={(event) => set({ models: event.target.value })} />
        <span className="caption-muted">已配置 {configuredModels.length} 个。{MODEL_ID_HELP} 可手填，也可从模型列表加入。</span>
      </div>
      <div className="field model-discovery-field">
        <label htmlFor="provider-edit-discovered-model">从模型列表接口获取</label>
        <div className="model-discovery-row">
          <button type="button" className="btn btn-secondary" disabled={discovering || !canDiscover} onClick={onDiscover}>{discovering ? "获取中…" : "获取模型列表"}</button>
          <Select
            id="provider-edit-discovered-model"
            value={discoveredModel}
            disabled={!discoveredModels.length}
            searchable
            searchPlaceholder="搜索远程模型 ID"
            placeholder={discoveredModels.length ? `选择模型（${discoveredModels.length}）` : "获取后选择"}
            options={discoveredModels.map((model) => ({ value: model, label: model, badge: configuredModels.includes(model) ? "已加入" : undefined, badgeTone: "neutral" }))}
            onChange={onAddDiscoveredModel}
          />
        </div>
        <span className="caption-muted">按当前协议读取模型列表。列表只表示服务声称支持这些 ID，不证明模型身份。</span>
      </div>
    </div>{message ? <p className="caption manage-message" role="status">{message}</p> : null}<div className="dialog-actions"><button className="btn btn-secondary" disabled={busy} onClick={onClose}>取消</button><button className="btn btn-primary" disabled={busy || !form.name || !form.baseUrl || !configuredModels.length} onClick={onSubmit}>{busy ? "保存中…" : "保存修改"}</button></div></div></div>;
}

function ConnectionTestDialog({ provider, model, protocol, session, onModel, onProtocol, onStart, onClose }: { provider: ApiProvider; model: string; protocol: ApiProtocol; session: ApiConnectionTest | null; onModel: (value: string) => void; onProtocol: (value: ApiProtocol) => void; onStart: () => void; onClose: () => void }) {
  const running = session?.status === "running";
  return <div className="dialog-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog-card connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title"><h2 id="connection-title">测试供应商连接</h2><p className="dialog-description"><strong>{provider.name}</strong><br />{provider.baseUrl}</p><SelectField label="本次测试协议" value={protocol} disabled={running} onChange={(value) => onProtocol(value as ApiProtocol)} options={PROTOCOL_OPTIONS.map((item)=>[item.value,item.label,item.description])} help={protocolHelp(protocol)} /><div className="field"><label htmlFor="connection-model">模型</label><Select id="connection-model" value={model} disabled={running} searchable searchPlaceholder="搜索已保存模型" options={provider.models.map((value) => ({ value, label: value }))} onChange={onModel} /><p className="field-help">{MODEL_ID_HELP}</p></div><div className="cost-notice">发送一个最小请求；协议不兼容时最多再试 1 次，可能产生少量费用。成功只代表当前可连接，不证明模型身份。回答正文不会保存。</div>{session ? <div className={`connection-result status-${session.status}`} aria-live="polite"><strong>{running ? "正在测试…" : session.result?.message ?? session.status}</strong><dl><div><dt>请求协议</dt><dd>{protocolLabel(session.protocol)}</dd></div>{session.result ? <><div><dt>结果类别</dt><dd>{connectionCategoryLabel(session.result.category)}</dd></div><div><dt>HTTP 状态码</dt><dd>{session.result.httpStatus ?? "—"}</dd></div><div><dt>耗时</dt><dd>{session.result.latencyMs == null ? "—" : `${Math.round(session.result.latencyMs)} ms`}</dd></div><div><dt>服务自报模型 ID</dt><dd>{session.result.responseModel ?? "未返回"}</dd></div>{session.result.retryAfterMs != null ? <div><dt>建议等待时间</dt><dd>{Math.ceil(session.result.retryAfterMs / 1000)} 秒</dd></div> : null}</> : null}</dl><p className="field-help">服务自报的模型 ID 可以被供应商修改，只作为连接诊断信息，不用于确认身份。</p>{session.result?.advice ? <p>{session.result.advice}</p> : null}</div> : null}<div className="dialog-actions"><button className="btn btn-secondary" onClick={onClose}>{running ? "取消测试" : "关闭"}</button><button className="btn btn-primary" disabled={running || !model} onClick={onStart}>{running ? "测试中…" : session ? "重新测试" : "开始测试"}</button></div></div></div>;
}

function ReferenceManager({ providers: _providers, items, onChanged: _onChanged, onV2RunChanged: _onV2RunChanged }: {
  providers: ApiProvider[];
  items: ApiReference[];
  onChanged: () => Promise<void>;
  onV2RunChanged: (run: any | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const normalizedQuery = query.trim().toLocaleLowerCase("und");
  const builtinTotal = items.filter((item) => item.sourceType === "builtin-research").length;
  const builtin = items.filter((item) =>
    item.sourceType === "builtin-research"
    && (!normalizedQuery || item.modelClaimed.toLocaleLowerCase("und").includes(normalizedQuery)),
  );
  const totalPages = Math.max(1, Math.ceil(builtin.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const shownBuiltin = builtin.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => { setPage(1); }, [normalizedQuery, pageSize]);

  return (
    <div className="fade-in reference-page">
      <h1 className="page-title">参考样本</h1>
      <p className="page-sub">分别管理你采集的参考版本和公开研究样本。两者都只用于行为对照，不构成来源证明。</p>
      <V2ReferenceGovernance providers={_providers} onChanged={_onChanged} onRunChanged={_onV2RunChanged}/>
      <section className="card reference-group reference-library-card">
        <div className="reference-library-header">
          <div>
            <span className="reference-kicker">研究参考</span>
            <h2>公开研究样本库</h2>
            <p>用于快速查找已有行为样本，不代表厂商认证或官方来源。</p>
          </div>
          <span className="reference-library-count">{normalizedQuery ? `${builtin.length} 个匹配` : `共 ${builtinTotal} 个`}</span>
        </div>
        <div className="field reference-search">
          <label htmlFor="reference-search">按模型名称筛选</label>
          <input id="reference-search" type="search" value={query} placeholder="例如 gpt-5.5" onChange={(event)=>setQuery(event.target.value)} />
        </div>
        <div className="list reference-library-list">{shownBuiltin.map((item)=><div className="list-item" key={item.id}><div><div className="list-item-title">{item.modelClaimed}</div><div className="list-item-sub">采集日期：{new Date(item.enrolledAt).toLocaleDateString()} · 时效：{item.freshnessStatus==="current"?"当前有效":item.freshnessStatus==="usable"?"仍可使用":"已过期"} · 有数据的问题组合：{item.cellCoverage}</div></div><span className={`source-badge ${item.sourceType==="self-built-reference"?"tone-local":"tone-builtin"}`}>{item.sourceType==="self-built-reference"?`${item.level??"L2"} 自建参考`:"研究参考"}</span></div>)}</div>
        {builtin.length?<div className="pagination" aria-label="研究参考分页"><button className="btn btn-ghost" disabled={safePage<=1} onClick={()=>setPage((value)=>Math.max(1,value-1))}>上一页</button><span className="pagination-status">第 {safePage} / {totalPages} 页</span><button className="btn btn-ghost" disabled={safePage>=totalPages} onClick={()=>setPage((value)=>Math.min(totalPages,value+1))}>下一页</button><div className="pagination-size"><span className="caption">每页</span><Select id="reference-page-size" aria-label="每页显示数量" value={String(pageSize)} onChange={(value)=>setPageSize(Number(value))} options={[10,20,50].map((value)=>({value:String(value),label:`${value} 条`}))}/></div></div>:<p className="caption reference-empty">没有匹配的研究参考。</p>}
      </section>
    </div>
  );

}

function HistoryRunDetail({run,onBack,onVerifyAgain,onOpenReferences}:{run:any;onBack:()=>void;onVerifyAgain:(run:any)=>void;onOpenReferences:()=>void}) {
  const [shareMessage,setShareMessage]=useState("");
  const share=async()=>{try{const report=await api.createV2ShareReport(run.id);setShareMessage(`分享报告已创建，内容固定不再更新；有效期至 ${new Date(report.expiresAt).toLocaleString()}。报告 ID：${report.id}`);}catch(cause){setShareMessage(cause instanceof Error?cause.message:String(cause));}};
  if(run.mode==="reference_enrollment")return <section className="card card-narrow history-detail fade-in" aria-label="参考样本历史详情">
    <button type="button" className="page-back" onClick={onBack}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5" /></svg><span>返回历史记录</span></button>
    <h1 className="page-title">参考样本采集结果</h1>
    <p className="page-sub">这是历史记录中的采集结果。参考样本的版本状态和治理操作在“参考样本”页面管理。</p>
    <div className="meta-grid"><div>模型 <strong>{run.model}</strong></div><div>状态 <strong>{runStatusLabel(run.status)}</strong></div><div>采集预算 <strong>{run.budget?.maxEndpointRequests??"—"} 次请求</strong></div><div>创建时间 <strong>{new Date(run.createdAt).toLocaleString()}</strong></div></div>
    {run.error?<div className="notice-error">{run.error}</div>:null}
    <div className="btn-row"><button className="btn btn-primary" onClick={onOpenReferences}>打开参考样本</button><button className="btn btn-secondary" onClick={onBack}>返回历史记录</button></div>
  </section>;
  return <div className="history-detail fade-in" aria-label="历史验证结果">
    <V2ResultPanel run={run} onBack={onBack} backLabel="返回历史记录" contextLabel="历史验证结果" onRetry={()=>onVerifyAgain(run)} onExport={()=>download(api.v2ExportUrl(run.id,"json"))}/>
    <div className="export-row"><span className="caption">其他格式：</span><button className="btn btn-ghost" onClick={()=>download(api.v2ExportUrl(run.id,"markdown"))}>Markdown</button><button className="btn btn-ghost" onClick={()=>download(api.v2ExportUrl(run.id,"csv"))}>CSV</button><button className="btn btn-secondary" title="创建一份内容固定、7 天内可查看的分享报告" disabled={run.status!=="completed"} onClick={()=>void share()}>创建 7 天分享报告</button></div>
    {shareMessage?<p className="caption-muted share-message" role="status">{shareMessage}</p>:null}
  </div>;
}

function HistoryPreview({ v2Items, providers, onOpenV2, requestV2Delete }: {
  v2Items:any[]; providers: ApiProvider[]; onOpenV2:(run:any)=>void;requestV2Delete:(run:any)=>void;
}) {
  return <div className="fade-in">
    <h1 className="page-title">历史记录</h1>
    <p className="page-sub">查看每次验证的配置和结果。行为分只看回答接近度，综合分还包含质量与来源；都不是身份概率。</p>
    {!v2Items.length?<div className="reference-empty">暂无验证记录。</div>:null}
    <div className="list history-list">{v2Items.map((run)=>{const presentation=scorecardPresentation(run.result?.scorecard);return <div className="list-item history-row" key={run.id}><button className="history-button" onClick={()=>onOpenV2(run)}><div><div className="list-item-title">{providers.find((provider)=>provider.id===run.providerId)?.name??"已删除供应商"} · {run.model}</div><div className="list-item-sub">{new Date(run.createdAt).toLocaleString()} · {verificationModeLabel(run.mode)} · {runStatusLabel(run.status)}<br/>{presentation.primaryScore!=null?`${presentation.primaryScoreLabel} ${Math.round(Number(presentation.primaryScore))}/100 · ${presentation.label}${presentation.scopeLabel?`（${presentation.scopeLabel}）`:""}${presentation.secondaryScore!=null?` · 综合证据分 ${Math.round(Number(presentation.secondaryScore))}/100`:""}`:run.result?.scorecard?.label??run.result?.conclusion?.behavior?.label??"尚未形成结果"}</div></div></button><button className="icon-btn danger" aria-label={`删除验证记录 ${run.model}`} title="删除验证记录" disabled={["queued","running"].includes(run.status)} onClick={()=>requestV2Delete(run)}><TrashIcon/></button></div>;})}</div>
  </div>;
}
function Field({ label, value, onChange, placeholder, type="text", help }: { label:string; value:string; onChange:(v:string)=>void; placeholder?:string; type?:string; help?:string }) { return <div className="field"><label>{label}</label><input type={type} value={value} placeholder={placeholder} onChange={(e)=>onChange(e.target.value)} />{help?<p className="field-help">{help}</p>:null}</div>; }
function SelectField({ label,value,onChange,options,disabled=false,help }: {label:string;value:string;onChange:(v:string)=>void;options:string[][];disabled?:boolean;help?:string}) { const id=`field-${label.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "-")}`; return <div className="field"><label htmlFor={id}>{label}</label><Select id={id} value={value} disabled={disabled} onChange={onChange} options={options.map(([optionValue,optionLabel,description])=>({value:optionValue,label:optionLabel,description}))} />{help?<p className="field-help">{help}</p>:null}</div>; }
function elapsed(start?:string){ if(!start)return"0:00"; const seconds=Math.max(0,Math.floor((Date.now()-new Date(start).getTime())/1000)); return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`; }
function download(url:string){ const anchor=document.createElement("a"); anchor.href=url; anchor.rel="noopener"; document.body.append(anchor); anchor.click(); anchor.remove(); }

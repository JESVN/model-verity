import { useEffect, useRef, useState } from "react";
import { LoadingState, RunningPanel, Select, V2ResultPanel } from "@ui/index";
import { api, type ApiProtocol, type ApiProvider, type ApiReference, type ApiV2Run } from "./api";
import { DECLARED_PRODUCT_HELP, DECLARED_VENDOR_HELP, MODEL_ID_HELP, PROTOCOL_OPTIONS, REFERENCE_SAMPLE_HELP, SAMPLING_BUDGET_HELP, SURFACE_OPTIONS, VERIFY_PROFILE_OPTIONS, apiErrorMessage, comparabilityHelp, phaseLabel, profileLabel, protocolHelp, referenceLevelHelp, referenceLevelLabel, surfaceHelp, verificationModeHelp, verificationModeLabel } from "./terminology";
import { buildRetryConfiguration } from "./retry-config";
import { RunStatusPoller } from "./run-status-poller";
import { loadVerificationPreferences, preferredItem, preferredModel, saveVerificationPreferences } from "./verification-preferences";

const TRACK_KEY="model-verity.v2-track";
const MISSING_HISTORY_RESOURCE="__history-resource-unavailable__";
type ReferenceSource = "all" | "self-built" | "research";
const REFERENCE_SOURCES: { value: ReferenceSource; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "self-built", label: "自建参考" },
  { value: "research", label: "研究参考" },
];
interface Track {id:string;viewed:boolean}
function loadTrack():Track|null { try{const value=JSON.parse(localStorage.getItem(TRACK_KEY)??"null");return value?.id?{id:String(value.id),viewed:Boolean(value.viewed)}:null;}catch{return null;} }
function sameText(left:string|undefined,right:string|undefined){return Boolean(left?.trim()&&right?.trim()&&left.trim().toLocaleLowerCase("und")===right.trim().toLocaleLowerCase("und"));}
function modelKey(value:string|undefined){return (value??"").split("/").at(-1)?.replace(/[._]/g,"-").toLocaleLowerCase("und")??"";}
function bestReference(items:ApiReference[],model:string,currentId?:string){const key=modelKey(model);const exact=items.find((item)=>modelKey(item.modelClaimed)===key||modelKey(item.identity?.product)===key);if(exact)return exact.id;return items.some((item)=>item.id===currentId)?currentId??"":items[0]?.id??"";}
function validProtocol(value:unknown):value is ApiProtocol{return value==="openai-compatible"||value==="openai-responses"||value==="anthropic-messages";}
function savedText(value:unknown,fallback:string){return typeof value==="string"?value:fallback;}
export function V2Workspace({providers,references,initialRun,retryRun,onRunChanged,onRetryApplied}:{providers:ApiProvider[];references:ApiReference[];initialRun?:ApiV2Run|null;retryRun?:ApiV2Run|null;onRunChanged?:(run:ApiV2Run|null)=>void;onRetryApplied?:()=>void}){
 const auditProviders=providers.filter((value)=>value.role!=="reference"),referenceProviders=providers.filter((value)=>value.role!=="audit");
 const saved=useRef(loadVerificationPreferences()).current;
 const initialProvider=preferredItem(auditProviders,saved.providerId);
 const initialModel=preferredModel(initialProvider?.models,saved.model);
 const targetPreferenceValid=Boolean(initialProvider&&saved.providerId===initialProvider.id&&saved.model===initialModel);
 const initialReference=preferredItem(references,saved.referenceId);
 const initialReferenceProvider=preferredItem(referenceProviders,saved.referenceProviderId);
 const initialReferenceModel=preferredModel(initialReferenceProvider?.models,saved.referenceModel);
 const referencePreferenceValid=Boolean(initialReferenceProvider&&saved.referenceProviderId===initialReferenceProvider.id&&saved.referenceModel===initialReferenceModel);
 const [mode,setMode]=useState<"screening"|"paired">(saved.mode==="paired"?"paired":"screening"),[providerId,setProviderId]=useState(initialProvider?.id??"");
 const provider=providerId===MISSING_HISTORY_RESOURCE?undefined:auditProviders.find((value)=>value.id===providerId)??auditProviders[0];
 const [model,setModel]=useState(initialModel),[referenceId,setReferenceId]=useState(initialReference?.id??""),[profile,setProfile]=useState<"quick"|"audit"|"full">(saved.profile==="quick"||saved.profile==="full"?saved.profile:"audit");
 const [referenceSource,setReferenceSource]=useState<ReferenceSource>("all");
 const selectedReference=references.find((value)=>value.id===referenceId);
 const isSelfBuiltReference=(value:ApiReference)=>value.sourceType==="self-built-reference";
 const filteredReferences=referenceSource==="all"?references:references.filter((value)=>referenceSource==="self-built"?isSelfBuiltReference(value):!isSelfBuiltReference(value));
 const selfBuiltCount=references.filter(isSelfBuiltReference).length;
 const researchCount=references.length-selfBuiltCount;
 const referenceSourceCounts: Record<ReferenceSource, number>={all:references.length,"self-built":selfBuiltCount,research:researchCount};
 const [referenceProviderId,setReferenceProviderId]=useState(initialReferenceProvider?.id??"");
 const referenceProvider=referenceProviderId===MISSING_HISTORY_RESOURCE?undefined:referenceProviders.find((value)=>value.id===referenceProviderId)??referenceProviders[0];
 const [referenceModel,setReferenceModel]=useState(initialReferenceModel),[temporaryReferenceKey,setTemporaryReferenceKey]=useState("");
 const [targetProtocol,setTargetProtocol]=useState<ApiProtocol>(targetPreferenceValid&&validProtocol(saved.targetProtocol)?saved.targetProtocol:initialProvider?.protocol??"openai-compatible"),[referenceProtocol,setReferenceProtocol]=useState<ApiProtocol>(referencePreferenceValid&&validProtocol(saved.referenceProtocol)?saved.referenceProtocol:initialReferenceProvider?.protocol??"openai-compatible");
 const [vendor,setVendor]=useState(targetPreferenceValid?savedText(saved.vendor,"OpenAI"):"OpenAI"),[product,setProduct]=useState(targetPreferenceValid?savedText(saved.product,initialModel):initialModel),[surface,setSurface]=useState(targetPreferenceValid&&SURFACE_OPTIONS.some((value)=>value.value===saved.surface)?savedText(saved.surface,"api"):"api");
 const [referenceVendor,setReferenceVendor]=useState(referencePreferenceValid?savedText(saved.referenceVendor,"OpenAI"):"OpenAI"),[referenceProduct,setReferenceProduct]=useState(referencePreferenceValid?savedText(saved.referenceProduct,initialReferenceModel):initialReferenceModel),[referenceSurface,setReferenceSurface]=useState(referencePreferenceValid&&SURFACE_OPTIONS.some((value)=>value.value===saved.referenceSurface)?savedText(saved.referenceSurface,"api"):"api");
 const initialTrack=useRef(!initialRun?loadTrack():null).current;
 const [run,setRunState]=useState<ApiV2Run|null>(initialRun??null),[busy,setBusy]=useState(false),[restoring,setRestoring]=useState(Boolean(initialTrack)),[error,setError]=useState(""),[shareMessage,setShareMessage]=useState(""),[restoredMessage,setRestoredMessage]=useState(""),[syncMessage,setSyncMessage]=useState("");
 const appliedRetryId=useRef<string|null>(null);
 const retryProtocols=useRef<{providerId?:string;target?:ApiProtocol;referenceProviderId?:string;reference?:ApiProtocol}|null>(null);
 const pairCount=profile==="quick"?20:profile==="full"?240:80,maxRequests=pairCount*(mode==="paired"?2:1);
 const setRun=(value:ApiV2Run|null)=>{setRunState(value);onRunChanged?.(value);if(value)localStorage.setItem(TRACK_KEY,JSON.stringify({id:value.id,viewed:!["queued","running"].includes(value.status)}));else localStorage.removeItem(TRACK_KEY);};
 const setRunRef=useRef(setRun);
 setRunRef.current=setRun;
 const poller=useRef<RunStatusPoller<ApiV2Run>|null>(null);
 if(!poller.current)poller.current=new RunStatusPoller({fetchRun:api.v2Run,onUpdate:(value)=>setRunRef.current(value),onSyncError:(message)=>setSyncMessage(message??""),isActive:(status)=>["queued","running"].includes(status)});

 useEffect(()=>{if(provider){if(providerId!==provider.id){const next=provider.models[0]??"";setProviderId(provider.id);setModel(next);setProduct(next);setReferenceId((current)=>bestReference(references,next,current));setTargetProtocol(provider.protocol);}else if(!provider.models.includes(model)){const next=provider.models[0]??"";setModel(next);setProduct(next);setReferenceId((current)=>bestReference(references,next,current));}const restored=retryProtocols.current?.providerId===provider.id?retryProtocols.current.target:undefined;if(restored)setTargetProtocol(restored);if(retryProtocols.current?.providerId===provider.id)retryProtocols.current={...retryProtocols.current,providerId:undefined,target:undefined};}},[provider?.id,provider?.models.join("|")]);
 useEffect(()=>{if(referenceProvider){if(referenceProviderId!==referenceProvider.id){const next=referenceProvider.models[0]??"";setReferenceProviderId(referenceProvider.id);setReferenceModel(next);setReferenceProduct(next);setReferenceProtocol(referenceProvider.protocol);}else if(!referenceProvider.models.includes(referenceModel)){const next=referenceProvider.models[0]??"";setReferenceModel(next);setReferenceProduct(next);}const restored=retryProtocols.current?.referenceProviderId===referenceProvider.id?retryProtocols.current.reference:undefined;if(restored)setReferenceProtocol(restored);if(retryProtocols.current?.referenceProviderId===referenceProvider.id)retryProtocols.current={...retryProtocols.current,referenceProviderId:undefined,reference:undefined};}},[referenceProvider?.id,referenceProvider?.models.join("|")]);
 useEffect(()=>{
  if(!references.length)return;
  const visible=referenceSource==="all"?references:references.filter((value)=>referenceSource==="self-built"?isSelfBuiltReference(value):!isSelfBuiltReference(value));
  if(!visible.some((item)=>item.id===referenceId))setReferenceId(visible.length?bestReference(visible,model,referenceId):"");
 },[references,referenceId,model,referenceSource]);
 useEffect(()=>{if(initialRun?.id!==run?.id)setRunState(initialRun??null);},[initialRun?.id]);
 useEffect(()=>{saveVerificationPreferences({mode,providerId,model,referenceId,profile,referenceProviderId,referenceModel,targetProtocol,referenceProtocol,vendor,product,surface,referenceVendor,referenceProduct,referenceSurface});},[mode,providerId,model,referenceId,profile,referenceProviderId,referenceModel,targetProtocol,referenceProtocol,vendor,product,surface,referenceVendor,referenceProduct,referenceSurface]);
 useEffect(()=>{
  if(!retryRun){appliedRetryId.current=null;return;}
  if(appliedRetryId.current===retryRun.id)return;
  appliedRetryId.current=retryRun.id;
  const restored=buildRetryConfiguration(retryRun,providers,references);
  retryProtocols.current={providerId:restored.providerId,target:restored.targetProtocol,referenceProviderId:restored.referenceProviderId,reference:restored.referenceProtocol};
  setRunState(null);setError("");setShareMessage("");setMode(restored.mode);setProfile(restored.profile);
  setProviderId(restored.providerId??MISSING_HISTORY_RESOURCE);
  setModel(restored.model??"");
  if(restored.mode==="screening")setReferenceId(restored.referenceId??MISSING_HISTORY_RESOURCE);
  if(restored.mode==="paired"){
   setReferenceProviderId(restored.referenceProviderId??MISSING_HISTORY_RESOURCE);
   setReferenceModel(restored.referenceModel??"");
  }
  if(restored.vendor)setVendor(restored.vendor);
  if(restored.product)setProduct(restored.product);
  if(restored.surface)setSurface(restored.surface);
  if(restored.referenceVendor)setReferenceVendor(restored.referenceVendor);
  if(restored.referenceProduct)setReferenceProduct(restored.referenceProduct);
  if(restored.referenceSurface)setReferenceSurface(restored.referenceSurface);
  if(restored.targetProtocol)setTargetProtocol(restored.targetProtocol);
  if(restored.referenceProtocol)setReferenceProtocol(restored.referenceProtocol);
  const omitted=restored.omissions.length?` ${restored.omissions.join("；")}，请重新选择。`:"";
  setRestoredMessage(`已带入历史验证配置。${omitted} 请确认参考样本、协议和请求预算后再启动；API Key 不会从历史记录恢复。`);
  onRunChanged?.(null);onRetryApplied?.();
 },[retryRun?.id,providers,references]);

 useEffect(()=>{const restore=async(track:Track,initial=false)=>{try{const value=await api.v2Run(track.id);setRunRef.current(value);if(["queued","running"].includes(value.status))poller.current?.start(value.id);}catch{localStorage.removeItem(TRACK_KEY);}finally{if(initial)setRestoring(false);}};const sync=(event:StorageEvent)=>{if(event.key!==TRACK_KEY)return;const track=loadTrack();if(track)void restore(track);else{poller.current?.stop();setRunState(null);onRunChanged?.(null);}};const resume=()=>{if(document.visibilityState!=="hidden")poller.current?.refresh();};window.addEventListener("storage",sync);document.addEventListener("visibilitychange",resume);window.addEventListener("focus",resume);window.addEventListener("pageshow",resume);window.addEventListener("online",resume);if(initialTrack)void restore(initialTrack,true);else setRestoring(false);return()=>{window.removeEventListener("storage",sync);document.removeEventListener("visibilitychange",resume);window.removeEventListener("focus",resume);window.removeEventListener("pageshow",resume);window.removeEventListener("online",resume);poller.current?.stop();};},[]);

 const screeningLevel=(selectedReference?.level??"L3") as "L1"|"L2"|"L3";
 const screeningIdentity=selectedReference?.identity??{vendor:model.split("/")[0]||"unknown",product:selectedReference?.modelClaimed??model,surface:"unknown"};
 const screeningComparability:"P1"|"P2"|"P3" = selectedReference?.sourceType!=="self-built-reference"||screeningIdentity.surface==="unknown"?"P3":selectedReference.protocol===targetProtocol?"P1":"P2";
 const pairedIdentityMatches=sameText(vendor,referenceVendor)&&sameText(product,referenceProduct)&&surface===referenceSurface&&surface!=="unknown";
 const pairedComparability:"P1"|"P2"|"P3"=!pairedIdentityMatches?"P3":targetProtocol===referenceProtocol?"P1":"P2";
 const protocolComparability=mode==="screening"?screeningComparability:pairedComparability;
 const referenceLevel=mode==="screening"?screeningLevel:(referenceProvider?.baseUrl.includes("api.openai.com")?"L1":"L2");
 const canStart=Boolean(provider&&model&&(mode==="screening"?selectedReference:referenceProvider&&referenceModel));

 const start=async()=>{if(!provider||!model||!canStart)return;setBusy(true);setError("");setShareMessage("");setSyncMessage("");try{const expiresAt=new Date(Date.now()+60*60_000).toISOString();const authorization=await api.createBudgetAuthorization({providerIds:[provider.id,...(mode==="paired"&&referenceProvider?[referenceProvider.id]:[])],models:[model,...(mode==="paired"&&referenceModel?[referenceModel]:[])],maxEndpointRequests:maxRequests,maxInputTokens:maxRequests*800,maxOutputTokens:maxRequests*16,maxAttemptsPerEndpoint:1,expiresAt});const credential=mode==="paired"&&temporaryReferenceKey?await api.createCredentialSession("reference",temporaryReferenceKey):undefined;setTemporaryReferenceKey("");const declared=mode==="screening"?screeningIdentity:{vendor,product,surface};const value=await api.startV2Run({mode,providerId:provider.id,model,referenceId:mode==="screening"?referenceId:undefined,referenceProviderId:mode==="paired"?referenceProvider?.id:undefined,referenceModel:mode==="paired"?referenceModel:undefined,referenceCredentialSessionId:credential?.id,profile,protocolComparability,referenceLevel,identity:{declared,reference:mode==="paired"?{vendor:referenceVendor,product:referenceProduct,surface:referenceSurface}:undefined,observed:{requestedModel:model,targetProtocol,referenceProtocol:mode==="paired"?referenceProtocol:undefined}},budget:{authorizationId:authorization.id,maxPairs:pairCount,maxEndpointRequests:maxRequests,maxAttemptsPerEndpoint:1,expiresAt}});setRun(value);poller.current?.start(value.id);}catch(cause){setError(apiErrorMessage(cause instanceof Error?cause.message:String(cause)));}finally{setBusy(false);}};
 const cancel=async()=>{if(!run)return;poller.current?.stop(run.id);try{setRun(await api.cancelV2Run(run.id));}catch(cause){setError(apiErrorMessage(cause instanceof Error?cause.message:String(cause)));poller.current?.start(run.id);}};
 const share=async()=>{if(!run)return;try{const report=await api.createV2ShareReport(run.id);setShareMessage(`分享报告已创建，内容固定不再更新；有效期至 ${new Date(report.expiresAt).toLocaleString()}。报告 ID：${report.id}`);}catch(cause){setShareMessage(apiErrorMessage(cause instanceof Error?cause.message:String(cause)));}};

 if(restoring)return <LoadingState label="正在恢复验证状态" detail="同步上次运行和服务端进度"/>;
 if(run&&["queued","running"].includes(run.status))return <RunningPanel data={{profile:run.profile,progress:run.progress,phaseLabel:run.phase==="sampling"?"正在分析行为样本":phaseLabel(run.phase),cellCurrent:Math.max(1,Math.ceil(run.progress*Number(run.budget?.maxPairs??pairCount))),cellTotal:Number(run.budget?.maxPairs??pairCount),elapsedLabel:elapsed(run.startedAt),successCount:run.successCount,failCount:run.failCount,detailLines:[`${verificationModeLabel(run.mode)} · ${profileLabel(run.profile)}`,`最多 ${run.budget.maxEndpointRequests} 次请求；失败不会自动重试。`]}} syncMessage={syncMessage} onRefresh={()=>poller.current?.refresh()} onCancel={()=>void cancel()}/>;
 if(run?.mode==="reference_enrollment")return <ReferenceEnrollmentResult run={run} onBack={()=>setRun(null)}/>;
 if(run){const returnToVerify=()=>setRun(null);return <><V2ResultPanel run={run} onBack={returnToVerify} backLabel="返回验证" onRetry={returnToVerify} onExport={()=>download(api.v2ExportUrl(run.id,"json"))}/><div className="export-row"><span className="caption">其他格式：</span><button className="btn btn-ghost" onClick={()=>download(api.v2ExportUrl(run.id,"markdown"))}>Markdown</button><button className="btn btn-ghost" onClick={()=>download(api.v2ExportUrl(run.id,"csv"))}>CSV</button><button className="btn btn-secondary" title="创建一份内容固定、7 天内可查看的分享报告" disabled={run.status!=="completed"} onClick={()=>void share()}>创建 7 天分享报告</button></div>{shareMessage?<p className="caption-muted share-message" role="status">{shareMessage}</p>:null}</>;}

 return <section className="card card-narrow verify-simple fade-in" aria-label="验证设置">
  <h1 className="page-title">验证中转服务</h1>
  <div className="verification-disclaimer" role="note"><strong>验证结果仅供参考，无法保证百分之百准确。</strong><span>评分不是模型真实性概率或厂商认证。</span></div>
  {error?<div className="notice-error" role="alert">{error}</div>:null}
  {restoredMessage?<div className="restored-config-notice" role="status">{restoredMessage}</div>:null}
  <ExplainedField label="要验证的供应商" help="选择待检查的 API；它决定请求地址和使用的密钥。"><Select value={provider?.id??""} placeholder={providerId===MISSING_HISTORY_RESOURCE?"原供应商不可用，请重新选择":"请选择供应商"} options={auditProviders.map((value)=>({value:value.id,label:value.name}))} onChange={(value)=>{const next=auditProviders.find((item)=>item.id===value);const nextModel=next?.models[0]??"";setProviderId(value);setModel(nextModel);setProduct(nextModel);setTargetProtocol(next?.protocol??"openai-compatible");setReferenceId((current)=>bestReference(references,nextModel,current));}}/></ExplainedField>
  <ExplainedField label="模型" help={MODEL_ID_HELP}><Select searchable value={model} placeholder={provider?"请选择模型":"请先选择供应商"} options={(provider?.models??[]).map((value)=>({value,label:value}))} onChange={(value)=>{setModel(value);setProduct(value);setReferenceId((current)=>bestReference(references,value,current));}}/></ExplainedField>
  {mode==="screening"?<ExplainedField label="参考样本" help={REFERENCE_SAMPLE_HELP}>
   <div className="segmented reference-source-filter" role="group" aria-label="筛选参考样本来源">
    {REFERENCE_SOURCES.map((item)=>(
     <button key={item.value} type="button" className={referenceSource===item.value?"is-active":""} aria-pressed={referenceSource===item.value} onClick={()=>setReferenceSource(item.value)}>
      {item.label}<span className="segmented-count">{referenceSourceCounts[item.value]}</span>
     </button>
    ))}
   </div>
   <Select searchable value={referenceId} placeholder={referenceId===MISSING_HISTORY_RESOURCE?"原参考不可用，请重新选择":"请选择参考样本"} emptyMessage={referenceSource==="self-built"?"还没有自建参考":referenceSource==="research"?"没有研究参考":"没有匹配项"} options={filteredReferences.map((value)=>({value:value.id,label:value.label||value.modelClaimed,description:value.sourceType==="self-built-reference"?`${referenceLevelLabel(value.level)} · 采集于 ${new Date(value.enrolledAt).toLocaleDateString()}`:`公开研究样本 · ${referenceFreshnessText(value.freshnessStatus)} · 只能比较行为`,badge:value.sourceType==="self-built-reference"?(value.level??"L2"):"研究",badgeTone:value.sourceType==="self-built-reference"?"local":"builtin"}))} onChange={setReferenceId}/>
   {!references.length?<p className="field-help">当前没有参考样本。请先在“参考样本”页创建，或展开高级验证方式使用实时双端配对。</p>:referenceSource==="self-built"&&!filteredReferences.length?<p className="field-help">还没有自建参考。可先到“参考样本”页创建，或切换到“全部 / 研究参考”。</p>:null}
  </ExplainedField>:null}
  <ExplainedField label="检测深度" help={SAMPLING_BUDGET_HELP}><Select value={profile} options={VERIFY_PROFILE_OPTIONS} onChange={(value)=>setProfile(value as "quick"|"audit"|"full")}/></ExplainedField>

  <details className="details advanced-verification"><summary>高级验证方式</summary><p className="field-help">仅在实时对照或修正协议、产品声明时设置。</p>
   <ExplainedField label="验证方式" help={verificationModeHelp(mode)}><Select value={mode} options={[{value:"screening",label:"参考样本比对",description:"只请求目标端，再与已保存样本比较。适合日常验证，费用较低。"},{value:"paired",label:"实时双端配对",description:"同时请求目标端和你信任的参考端。对照更新，但请求数和费用约为两倍。"}]} onChange={(value)=>setMode(value as "screening"|"paired")}/></ExplainedField>
   <div className="advanced-grid"><ExplainedField label="目标请求协议" help={protocolHelp(targetProtocol)}><ProtocolSelect value={targetProtocol} onChange={setTargetProtocol}/></ExplainedField>
   {mode==="paired"?<><ExplainedField label="可信参考供应商" help="选择实时对照的可信 API；两端都会产生请求和费用。"><Select value={referenceProvider?.id??""} placeholder={referenceProviderId===MISSING_HISTORY_RESOURCE?"原参考供应商不可用，请重新选择":"请选择参考供应商"} options={referenceProviders.map((value)=>({value:value.id,label:value.name}))} onChange={(value)=>{const next=referenceProviders.find((item)=>item.id===value);const nextModel=next?.models[0]??"";setReferenceProviderId(value);setReferenceModel(nextModel);setReferenceProduct(nextModel);setReferenceProtocol(next?.protocol??"openai-compatible");}}/></ExplainedField><ExplainedField label="参考模型" help={MODEL_ID_HELP}><Select searchable value={referenceModel} placeholder={referenceProvider?"请选择参考模型":"请先选择参考供应商"} options={(referenceProvider?.models??[]).map((value)=>({value,label:value}))} onChange={(value)=>{setReferenceModel(value);setReferenceProduct(value);}}/></ExplainedField><ExplainedField label="参考请求协议" help={protocolHelp(referenceProtocol)}><ProtocolSelect value={referenceProtocol} onChange={setReferenceProtocol}/></ExplainedField><Field label="目标声明厂商" value={vendor} onChange={setVendor} help={DECLARED_VENDOR_HELP}/><Field label="目标声明产品" value={product} onChange={setProduct} help={DECLARED_PRODUCT_HELP}/><ExplainedField label="目标产品形态" help={surfaceHelp(surface)}><Select value={surface} options={SURFACE_OPTIONS} onChange={setSurface}/></ExplainedField><Field label="参考声明厂商" value={referenceVendor} onChange={setReferenceVendor} help={DECLARED_VENDOR_HELP}/><Field label="参考声明产品" value={referenceProduct} onChange={setReferenceProduct} help={DECLARED_PRODUCT_HELP}/><ExplainedField label="参考产品形态" help={surfaceHelp(referenceSurface)}><Select value={referenceSurface} options={SURFACE_OPTIONS} onChange={setReferenceSurface}/></ExplainedField><ExplainedField label="临时参考端 API Key（可选）" help="留空则使用已保存密钥。填写后仅存内存，并在完成、失败、取消、过期或重启后销毁。"><input type="password" autoComplete="off" value={temporaryReferenceKey} onChange={(event)=>setTemporaryReferenceKey(event.target.value)} placeholder="留空则使用已保存密钥"/></ExplainedField></>:null}</div>
   <div className="advanced-summary"><strong>系统判断：{protocolComparability} · {referenceLevelLabel(referenceLevel)}</strong><span>{comparabilityHelp(protocolComparability)} {referenceLevelHelp(referenceLevel)} 等级自动计算，不能手工提高。</span></div>
  </details>

  <div className="verification-budget"><div><strong>{profileLabel(profile)}检测</strong><span>{pairCount} 组样本 · 最多 {maxRequests} 次 API 请求</span></div><p>约 {maxRequests*800} 个输入 token、{maxRequests*16} 个输出 token（计费文本单位）。可能产生费用；不重试或追加预算。</p></div>
  <button className="btn btn-primary btn-block" disabled={!canStart||busy} onClick={()=>void start()}>{busy?"正在授权…":`确认并开始验证`}</button>
 </section>;
}

function ReferenceEnrollmentResult({run,onBack}:{run:ApiV2Run;onBack:()=>void}){return <section className="card card-narrow"><h1>{run.status==="completed"?"参考样本已创建":"参考采集未完成"}</h1><p>{run.error?apiErrorMessage(run.error):"参考版本已保存。"}</p><button className="btn btn-secondary" onClick={onBack}>返回验证</button></section>;}
function ProtocolSelect({value,onChange}:{value:ApiProtocol;onChange:(value:ApiProtocol)=>void}){return <Select value={value} options={PROTOCOL_OPTIONS} onChange={(next)=>onChange(next as ApiProtocol)}/>;}
function ExplainedField({label,children,help}:{label:string;children:any;help?:string}){return <div className="field"><label>{label}</label>{children}{help?<p className="field-help">{help}</p>:null}</div>;}
function Field({label,value,onChange,help}:{label:string;value:string;onChange:(value:string)=>void;help?:string}){return <div className="field"><label>{label}</label><input value={value} onChange={(event)=>onChange(event.target.value)}/>{help?<p className="field-help">{help}</p>:null}</div>;}
function referenceFreshnessText(value:ApiReference["freshnessStatus"]){return value==="current"?"当前有效":value==="usable"?"仍可使用":"已过期";}
function elapsed(start?:string){if(!start)return"0:00";const seconds=Math.max(0,Math.floor((Date.now()-new Date(start).getTime())/1000));return`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`;}
function download(url:string){const anchor=document.createElement("a");anchor.href=url;anchor.rel="noopener";document.body.append(anchor);anchor.click();anchor.remove();}

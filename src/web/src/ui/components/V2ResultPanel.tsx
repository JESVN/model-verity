import { scorecardPresentation, scoreVisualLevel } from "../../../../core/v3/presentation";
import { comparabilityLabel, referenceLevelLabel, verificationModeLabel } from "../../app/terminology";

export interface V2ResultPanelProps {
  run: any;
  onBack: () => void;
  backLabel?: string;
  contextLabel?: string;
  onRetry?: () => void;
  onExport?: () => void;
}

const BAND_TONE:Record<string,string>={high:"high",basic:"basic",review:"mid",low:"low",unscored:"neutral"};
const DIMENSION_HELP:Record<string,string>={
  behavior:"回答与参考的接近程度；不证明模型来源。",
  quality:"请求成功率和有效问题覆盖。",
  stability:"本次测试是否前后一致；不代表长期稳定。",
  comparability:"两端产品、形态和请求方式是否一致。",
  reference:"参考来源强度和采集时效。",
};
const RAW_DIMENSIONS = [
  ["behavior","行为判断"],
  ["provenance","来源判断"],
  ["stability","短时稳定判断"],
  ["comparability","比较条件判断"],
  ["freshness","参考新旧判断"],
] as const;

function TechnicalMetric({label,value,help}:{label:string;value:any;help:string}){return <div><span>{label}</span><strong>{value}</strong><small>{help}</small></div>;}
function bandText(value:string|undefined){return({high:"高",basic:"基本可信",review:"需复核",low:"低",unscored:"无法评分"} as Record<string,string>)[value??""]??"未记录";}

export function V2ResultPanel({ run, onBack, backLabel = "返回验证", contextLabel, onRetry = onBack, onExport }: V2ResultPanelProps) {
  const result=run.result??{},scorecard=result.scorecard,conclusion=result.conclusion;
  const presentation=scorecardPresentation(scorecard);
  const score=presentation.primaryScore;
  const tone=scorecard?BAND_TONE[scoreVisualLevel(scorecard)]??"neutral":run.status==="failed"?"failed":"neutral";
  const technicalId=`technical-${run.id}`;
  return <section className="card result-card v2-result fade-in" aria-label="验证结果">
    <button type="button" className="page-back" onClick={onBack}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5" /></svg><span>{backLabel}</span></button>
    {contextLabel?<div className="result-context-label">{contextLabel}</div>:null}

    <div className={`trust-score-hero tone-${tone}`}>
      <div className="trust-score-value" aria-label={score==null?"无法评分":`${presentation.primaryScoreLabel} ${score} 分`}>
        {score==null?<strong>—</strong>:<><strong>{Math.round(Number(score))}</strong><span>/ 100</span></>}
      </div>
      <div className="trust-score-copy">
        <span className="caption-muted">{presentation.primaryScoreLabel}</span>
        <h1>{scorecard?presentation.label:(run.status==="failed"?"验证失败":"无法评分")}</h1>
        {presentation.scopeLabel?<span className="result-scope-label">{presentation.scopeLabel}</span>:null}
        {presentation.secondaryScore!=null?<span className="result-secondary-score">综合证据分 {Math.round(Number(presentation.secondaryScore))}/100</span>:null}
        <p>{presentation.summary??scorecard?.summary??(run.error?`验证未完成：${run.error}`:"本次没有形成可评分结果。")}</p>
      </div>
    </div>
    <div className="result-scope-notice" role="note"><strong>验证结果仅供参考，无法保证百分之百准确。</strong> 评分不是身份概率或厂商认证。</div>

    {scorecard?.reasons?.length?<section className="result-key-points" aria-label="关键说明"><h2>关键说明</h2><ul>{scorecard.reasons.map((value:string)=><li key={value}>{value}</li>)}</ul></section>:null}

    {scorecard?.dimensions?.length?<section className="score-dimensions" aria-label="评分组成">
      <div className="section-heading"><h2 className="section-title">评分组成</h2><span className="caption">权重合计 100%</span></div>
      {scorecard.dimensions.map((item:any)=><div className="score-dimension" key={item.key}>
        <div className="score-dimension-head"><span>{item.label} <small>权重 {item.weight}%</small></span><strong>{Math.round(Number(item.score))}</strong></div>
        <div className="score-dimension-track" aria-hidden><i style={{width:`${Math.max(0,Math.min(100,Number(item.score)))}%`}} /></div>
        <p>{DIMENSION_HELP[item.key]}</p>
      </div>)}
    </section>:null}

    {scorecard?.caps?.length?<section className="score-cap-notice"><strong>{presentation.scopeLimited?"证据范围限制（不代表行为不相似）":"结论为何被限制"}</strong><ul>{scorecard.caps.map((value:string)=><li key={value}>{value}</li>)}</ul></section>:null}

    <details className="details technical-details" id={technicalId}>
      <summary>查看技术详情</summary>
      <p className="field-help">用于专业复核和导出；单项数值不是身份概率。</p>
      <div className="technical-score-grid">
        <TechnicalMetric label="回答分布差异（JSD）" value={result.distance?.score==null?"—":Number(result.distance.score).toFixed(3)} help="0 最接近，越接近 1 差异越大；不是身份概率。"/>
        <TechnicalMetric label="有效问题覆盖" value={result.coverage==null?"—":`${Math.round(Number(result.coverage)*100)}%`} help="可公平比较的问题占比；越高越完整。"/>
        <TechnicalMetric label="验证方式" value={verificationModeLabel(run.mode)} help="样本比对只请求目标端；实时配对请求两端。"/>
        <TechnicalMetric label="比较条件" value={comparabilityLabel(run.protocolComparability)} help="条件越不一致，结论范围越窄。"/>
        <TechnicalMetric label="参考来源" value={referenceLevelLabel(run.referenceLevel)} help="等级越低，来源结论越受限。"/>
        <TechnicalMetric label="实际请求 / 最多请求" value={`${result.manifest?.requestsUsed??run.successCount+run.failCount}/${result.manifest?.maxRequests??run.budget?.maxEndpointRequests}`} help="已发送请求 / 已批准上限。"/>
        <TechnicalMetric label="行为相似分 / 综合证据分" value={`${Math.round(Number(scorecard?.dimensions?.find((item:any)=>item.key==="behavior")?.score??0))} / ${scorecard?.score==null?"—":Math.round(Number(scorecard.score))}`} help="前者只看行为；后者还含质量、稳定性和来源。"/>
        <TechnicalMetric label="数值等级 / 限制后等级" value={`${bandText(scorecard?.rawBand)} / ${bandText(scorecard?.band)}`} help="后者还应用校准、来源和覆盖限制。"/>
        <TechnicalMetric label="校准状态" value={scorecard?.calibrated?"已匹配":"未匹配"} help="校准用已知样本确定边界；未匹配时结论更保守。"/>
      </div>
      <div className="raw-evidence-list">{RAW_DIMENSIONS.map(([key,label])=><div key={key}><span>{label}</span><strong>{conclusion?.[key]?.label??"数据不足"}</strong><p>{conclusion?.[key]?.detail??"本次证据不足。"}</p></div>)}</div>
      {result.bootstrap?.low!=null?<p className="technical-line"><strong>重复抽样区间：</strong>{Number(result.bootstrap.low).toFixed(3)}–{Number(result.bootstrap.high).toFixed(3)}；越窄表示数值越稳定。</p>:null}
      {result.genuineConformalP!=null?<p className="technical-line"><strong>同源样本尾部比例：</strong>{Number(result.genuineConformalP).toFixed(3)}；同源样本出现当前或更大差异的比例，不是身份概率。</p>:null}
      {result.impostorAcceptanceRisk!=null?<p className="technical-line"><strong>异源样本误接近比例：</strong>{Number(result.impostorAcceptanceRisk).toFixed(3)}；越低越好，仅适用于当前校准。</p>:null}
      <p className="technical-line"><strong>采样清单：</strong><code>{result.manifest?.version??"未记录"}</code> · <code>{result.manifest?.promptMode==="fixed"?"内置固定问题":result.manifest?.promptMode==="marked"?"配对标记问题":"提问方式未记录"}</code>。两端使用同一提问方式。</p>
      <p className="technical-line"><strong>清单校验值：</strong><code>{result.manifest?.id??"未形成"}</code>。用于核对报告清单，不证明模型来源。</p>
      {conclusion?.limitations?.length?<div className="technical-limitations"><strong>本次结果的适用限制</strong><ul>{conclusion.limitations.map((value:string)=><li key={value}>{value}</li>)}</ul></div>:null}
    </details>

    <div className="btn-row result-primary-actions"><button className="btn btn-primary" onClick={onRetry}>再次验证</button>{onExport?<button className="btn btn-secondary" onClick={onExport}>导出完整报告</button>:null}</div>
  </section>;
}

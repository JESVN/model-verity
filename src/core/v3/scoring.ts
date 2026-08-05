import type { CalibrationArtifact, ProtocolComparability, ReferenceLevel } from "../v2/types.js";

export const V3_SCORING_POLICY_VERSION = "pamela-scorecard@3.1.0";

export type TrustBand = "high" | "basic" | "review" | "low" | "unscored";
export type FreshnessStatus = "current" | "usable" | "stale" | "review_required" | "quarantined" | "superseded";

export interface ScoreDimension {
  key: "behavior" | "quality" | "stability" | "comparability" | "reference";
  label: string;
  score: number;
  weight: number;
  contribution: number;
  detail: string;
}

export interface TrustScorecard {
  policyVersion: string;
  score?: number;
  displayScore?: number;
  displayScoreLabel: "行为相似评分" | "综合可信评分";
  rawBand: TrustBand;
  band: TrustBand;
  label: string;
  scopeLabel?: string;
  summary: string;
  calibrated: boolean;
  dimensions: ScoreDimension[];
  caps: string[];
  reasons: string[];
  disclaimer: string;
}

export interface TrustScoreInput {
  jsd?: number;
  successRate: number;
  coverage: number;
  stabilityStatus?: string;
  protocolComparability: ProtocolComparability;
  referenceLevel: ReferenceLevel;
  referenceFreshness: FreshnessStatus;
  calibration?: CalibrationArtifact;
  genuineConformalP?: number;
  impostorAcceptanceRisk?: number;
}

const WEIGHTS = { behavior: 55, quality: 15, stability: 10, comparability: 10, reference: 10 } as const;
const DISCLAIMER = "评分仅供参考，无法保证百分之百准确；它不是模型为真的概率、厂商认证或未来保证。";

export function computeTrustScore(input: TrustScoreInput): TrustScorecard {
  if (input.jsd == null || !Number.isFinite(input.jsd)) {
    return {
      policyVersion: V3_SCORING_POLICY_VERSION,
      displayScoreLabel: "综合可信评分",
      rawBand: "unscored",
      band: "unscored",
      label: "无法评分",
      summary: "本次没有形成可比的行为距离，无法计算综合可信评分。",
      calibrated: Boolean(input.calibration),
      dimensions: [],
      caps: ["缺少可比行为样本"],
      reasons: ["请检查请求成功率、参考样本和采样覆盖后重新验证。"],
      disclaimer: DISCLAIMER,
    };
  }

  const jsd = clamp(input.jsd);
  const successRate = clamp(input.successRate);
  const coverage = clamp(input.coverage);
  const behaviorScore = input.calibration
    ? calibratedBehaviorScore(jsd, input.calibration, input.genuineConformalP, input.impostorAcceptanceRisk)
    : clampScore(100 * (1 - jsd));
  const qualityScore = clampScore((successRate * 10 + coverage * 5) / 15 * 100);
  const stabilityScore = stabilityValue(input.stabilityStatus);
  const comparabilityScore = ({ P1: 100, P2: 70, P3: 35 } as const)[input.protocolComparability];
  const referenceScore = clampScore(referenceBase(input.referenceLevel) * freshnessMultiplier(input.referenceFreshness));

  const dimensions: ScoreDimension[] = [
    dimension("behavior", "行为一致性", behaviorScore, WEIGHTS.behavior, input.calibration
      ? `行为距离 ${jsd.toFixed(3)}，按匹配的校准数据换算。`
      : `行为距离 ${jsd.toFixed(3)}，按未校准的连续展示函数换算。`),
    dimension("quality", "请求质量", qualityScore, WEIGHTS.quality, `请求成功率 ${percent(successRate)}，可比采样覆盖 ${percent(coverage)}。`),
    dimension("stability", "短时稳定性", stabilityScore, WEIGHTS.stability, stabilityDetail(input.stabilityStatus)),
    dimension("comparability", "可比性", comparabilityScore, WEIGHTS.comparability, comparabilityDetail(input.protocolComparability)),
    dimension("reference", "参考强度", referenceScore, WEIGHTS.reference, referenceDetail(input.referenceLevel, input.referenceFreshness)),
  ];
  const score = clampScore(dimensions.reduce((sum, item) => sum + item.contribution, 0));
  const rawBand = bandFor(score);
  const caps = conclusionCaps(input, successRate, coverage);
  const band = applyCaps(rawBand, caps);
  const presentation = presentationFor(input, dimensions, rawBand, band, caps, successRate, coverage);
  const reasons = keyReasons(dimensions, caps, input.calibration, presentation.scopeLimited);

  return {
    policyVersion: V3_SCORING_POLICY_VERSION,
    score: round(score, 1),
    displayScore: round(presentation.scopeLimited ? behaviorScore : score, 1),
    displayScoreLabel: presentation.scopeLimited ? "行为相似评分" : "综合可信评分",
    rawBand,
    band,
    label: presentation.label,
    scopeLabel: presentation.scopeLabel,
    summary: presentation.summary,
    calibrated: Boolean(input.calibration),
    dimensions,
    caps,
    reasons,
    disclaimer: DISCLAIMER,
  };
}

function calibratedBehaviorScore(jsd: number, calibration: CalibrationArtifact, genuineP?: number, impostorRisk?: number): number {
  const support = clamp(calibration.supportMax);
  const anomaly = Math.max(support, clamp(calibration.anomalyMin));
  let score: number;
  if (jsd <= support) score = support > 0 ? 100 - 10 * jsd / support : 100;
  else if (jsd < anomaly) score = 90 - 55 * (jsd - support) / Math.max(1e-9, anomaly - support);
  else score = 35 * (1 - (jsd - anomaly) / Math.max(1e-9, 1 - anomaly));
  if (impostorRisk != null) score += impostorRisk <= 0.01 ? 3 : impostorRisk >= 0.1 ? -3 : 0;
  if (genuineP != null) score += genuineP <= 0.01 ? -2 : genuineP >= 0.1 ? 2 : 0;
  return clampScore(score);
}

function conclusionCaps(input: TrustScoreInput, successRate: number, coverage: number): string[] {
  const caps: string[] = [];
  if (!input.calibration) caps.push("当前模型和采样条件没有匹配校准，最高为“基本可信”");
  if (input.protocolComparability === "P3") caps.push("目标与参考仅作诊断比较，最高为“需要复核”");
  if (input.referenceLevel === "L3" && input.referenceFreshness === "stale") caps.push("使用已老化的研究参考，最高为“需要复核”");
  if (["behavioral_mixture", "conditional_fallback", "unstable"].includes(input.stabilityStatus ?? "")) caps.push("检测到短时行为变化或服务波动，最高为“需要复核”");
  if (successRate < 0.9) caps.push("请求成功率低于 90%，最高为“需要复核”");
  if (coverage < 0.75) caps.push("可比采样覆盖低于 75%，最高为“需要复核”");
  if (["review_required", "quarantined", "superseded"].includes(input.referenceFreshness)) caps.push("参考质量状态不允许可信结论，最高为“可信度较低”");
  return caps;
}

function applyCaps(raw: TrustBand, caps: string[]): TrustBand {
  let maximum: TrustBand = "high";
  if (caps.some((value) => value.includes("最高为“基本可信”"))) maximum = lower(maximum, "basic");
  if (caps.some((value) => value.includes("最高为“需要复核”"))) maximum = lower(maximum, "review");
  if (caps.some((value) => value.includes("最高为“可信度较低”"))) maximum = lower(maximum, "low");
  return lower(raw, maximum);
}

function presentationFor(input: TrustScoreInput, dimensions: ScoreDimension[], rawBand: TrustBand, band: TrustBand, caps: string[], successRate: number, coverage: number): { label: string; scopeLabel?: string; summary: string; scopeLimited: boolean } {
  const behavior = dimensions[0].score;
  const stabilityIsSound = ["stable_window", "possible_multi_serving"].includes(input.stabilityStatus ?? "");
  const scopeLimited = input.protocolComparability === "P3"
    && behavior >= 70
    && successRate >= 0.9
    && coverage >= 0.75
    && stabilityIsSound
    && caps.every((value) => value.includes("没有匹配校准") || value.includes("仅作诊断比较") || value.includes("已老化的研究参考"));
  if (scopeLimited && (rawBand === "high" || rawBand === "basic") && band === "review") {
    const highSimilarity = behavior >= 90;
    return {
      label: highSimilarity ? "行为高度相似" : "行为较为相似",
      scopeLabel: input.referenceLevel === "L3" ? "来源证据待复核" : "比较范围待复核",
      summary: highSimilarity
        ? "本次回答分布与参考高度接近，请求质量和短时稳定性良好；当前参考只能支持行为比较，不能确认实际上游来源。"
        : "本次回答分布与参考较为接近；当前参考只能支持行为比较，仍需结合可信参考路径复核来源。",
      scopeLimited: true,
    };
  }
  return { label: bandLabel(band), summary: summaryFor(band, caps), scopeLimited: false };
}

function keyReasons(dimensions: ScoreDimension[], caps: string[], calibrated?: CalibrationArtifact, scopeLimited = false): string[] {
  const behavior = dimensions[0];
  const quality = dimensions.find((item) => item.key === "quality")!;
  const stability = dimensions.find((item) => item.key === "stability")!;
  const weakest = [...dimensions.slice(1)].sort((a, b) => a.score - b.score)[0];
  const reasons = scopeLimited ? [
    `未校准行为相似度为 ${Math.round(behavior.score)}/100；该数值描述回答分布接近程度，不是模型真实性概率。`,
    quality.score >= 90 && stability.score >= 65 ? "本次请求质量充足，短时采样未发现需要降级的服务波动。" : `${weakest.label}是本次主要限制：${weakest.detail}`,
    "研究或诊断参考不能证明实际上游来源；需要同产品面可信参考或官方直连配对才能提升来源证据。",
  ] : [
    behavior.score >= 70 ? "目标回答分布与参考较接近。" : behavior.score >= 40 ? "目标回答分布与参考存在一定差异。" : "目标回答分布与参考差异较大。",
    weakest.score < 70 ? `${weakest.label}是本次主要限制：${weakest.detail}` : "本次请求质量、短时稳定性和比较条件未出现明显短板。",
    caps[0] ?? (calibrated ? "本次使用了匹配校准数据。" : "本次没有匹配校准数据，分数只作相对比较。"),
  ];
  return [...new Set(reasons)].slice(0, 3);
}

function dimension(key: ScoreDimension["key"], label: string, score: number, weight: number, detail: string): ScoreDimension {
  const safe = round(clampScore(score), 1);
  return { key, label, score: safe, weight, contribution: round(safe * weight / 100, 2), detail };
}
function stabilityValue(status?: string): number { return ({ stable_window: 100, possible_multi_serving: 65, insufficient_data: 55, behavioral_mixture: 35, conditional_fallback: 25, unstable: 20 } as Record<string, number>)[status ?? ""] ?? 55; }
function stabilityDetail(status?: string): string { return ({ stable_window: "本次采样窗口内未发现明显分组变化。", possible_multi_serving: "响应声明提示可能存在多路后端；该字段只是弱信号。", insufficient_data: "分组有效样本不足，无法充分分析短时变化。", behavioral_mixture: "不同采样分组呈现明显行为变化。", conditional_fallback: "首次与后续尝试呈现不同模式，可能存在条件式路由。", unstable: "请求成功率或响应表现显示服务波动。" } as Record<string, string>)[status ?? ""] ?? "短时稳定性证据不足。"; }
function comparabilityDetail(value: ProtocolComparability): string { return value === "P1" ? "目标与参考的模型产品、产品面和协议严格一致。" : value === "P2" ? "模型产品和产品面一致，但协议经过语义映射。" : "产品面、参考元数据或协议条件不足，只作诊断比较。"; }
function referenceBase(value: ReferenceLevel): number { return value === "L1" ? 100 : value === "L2" ? 75 : 45; }
function freshnessMultiplier(value: FreshnessStatus): number { return ({ current: 1, usable: .85, stale: .55, review_required: .35, quarantined: 0, superseded: 0 } as const)[value]; }
function referenceDetail(level: ReferenceLevel, freshness: FreshnessStatus): string { const source = level === "L1" ? "官方直连参考" : level === "L2" ? "用户信任路径" : "研究或本地参考"; const age = ({ current: "当前有效", usable: "仍可使用", stale: "已老化", review_required: "需要复核", quarantined: "已暂停使用", superseded: "已被替代" } as const)[freshness]; return `${source}，参考状态为“${age}”。`; }
function bandFor(score: number): TrustBand { return score >= 85 ? "high" : score >= 70 ? "basic" : score >= 50 ? "review" : "low"; }
function bandLabel(value: TrustBand): string { return ({ high: "可信度较高", basic: "基本可信", review: "需要复核", low: "可信度较低", unscored: "无法评分" } as const)[value]; }
function summaryFor(band: TrustBand, caps: string[]): string { const base = band === "high" ? "本次证据对服务声明提供了较强支持。" : band === "basic" ? "本次证据整体支持服务声明，但仍有适用范围限制。" : band === "review" ? "本次证据不足以直接信任或否定服务声明，建议复核。" : band === "low" ? "本次证据对服务声明的支持较弱，使用前应重点核查。" : "本次没有形成可评分结果。"; return caps.length ? `${base} 结论已因关键限制降级。` : base; }
function lower(left: TrustBand, right: TrustBand): TrustBand { const rank: Record<TrustBand, number> = { unscored: -1, low: 0, review: 1, basic: 2, high: 3 }; return rank[left] <= rank[right] ? left : right; }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function clampScore(value: number): number { return Math.max(0, Math.min(100, value)); }
function round(value: number, digits: number): number { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function percent(value: number): string { return `${Math.round(value * 100)}%`; }

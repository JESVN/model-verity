import { compareFingerprints, type CellDistribution, type FingerprintDistance } from "../stats/index.js";
import { bootstrapMeanInterval, empiricalTailProbability } from "./calibration.js";
import type { CalibrationArtifact, ProtocolComparability, ReferenceLevel, V2Conclusion } from "./types.js";
import { V2_FRAMEWORK_VERSION, V2_POLICY_VERSION } from "./types.js";

export interface EndpointEvidenceInput {
  reference: { cells: Record<string, CellDistribution> };
  candidate: { cells: Record<string, CellDistribution> };
  cellIds: string[];
  minValid: number;
  calibration?: CalibrationArtifact;
  protocolComparability: ProtocolComparability;
  referenceLevel: ReferenceLevel;
  referenceFreshness: "current" | "usable" | "stale" | "review_required" | "quarantined";
  successRate: number;
  responseModels: Record<string, number>;
  repeatWindowConfirmed?: boolean;
}

export interface V2Evidence {
  distance: FingerprintDistance;
  bootstrap: { low?: number; high?: number; mean?: number };
  genuineConformalP?: number;
  impostorAcceptanceRisk?: number;
  coverage: number;
  conclusion: V2Conclusion;
}

export function evaluateEvidence(input: EndpointEvidenceInput): V2Evidence {
  const distance = compareFingerprints(input.reference, input.candidate, input.cellIds, input.minValid);
  const values = distance.cells.map((cell) => cell.jsd);
  const bootstrap = bootstrapMeanInterval(values, { seed: input.cellIds.join("|") });
  const score = distance.score;
  const calibration = input.calibration;
  const coverage = input.cellIds.length ? distance.cells.length / input.cellIds.length : 0;
  const genuineConformalP = score != null && calibration ? empiricalTailProbability(calibration.genuineDistances, score, "upper") : undefined;
  const impostorAcceptanceRisk = score != null && calibration
    ? (calibration.impostorDistances.filter((value) => value <= score).length + 1) / (calibration.impostorDistances.length + 1)
    : undefined;
  const blocked = !calibration
    || input.protocolComparability !== "P1"
    || ["stale", "review_required", "quarantined"].includes(input.referenceFreshness)
    || coverage < (calibration?.minCoverage ?? 1)
    || input.successRate < 0.9;
  const support = !blocked && score != null && score <= calibration!.supportMax && (impostorAcceptanceRisk ?? 1) <= 0.01;
  const anomaly = !blocked && score != null && score >= calibration!.anomalyMin && (genuineConformalP ?? 1) <= 0.01 && Boolean(input.repeatWindowConfirmed);
  const behavior = support
    ? { status: "supported", label: "行为支持", detail: "在当前校准范围内与目标产品行为相容。" }
    : anomaly
      ? { status: "anomalous", label: "明显异常", detail: "在重复观察窗口中，行为距离稳定落在已知同源样本很少出现的异常区域。" }
      : calibration
        ? { status: "review", label: "需要复核", detail: "证据位于复核区，或质量/协议门禁不足。" }
        : { status: "uncalibrated", label: "未校准", detail: "没有与当前模型产品、产品面、协议和采样档位匹配的校准数据，不能产生强结论。" };
  const provenance = input.referenceLevel === "L1"
    ? { status: "paired_first_party", label: "第一方参考", detail: "比较参考为系统识别的官方直连；行为比较仍不是密码学来源证明。" }
    : input.referenceLevel === "L2"
      ? { status: "user_trusted", label: "用户信任参考", detail: "参考可信性由用户声明。" }
      : { status: "research", label: "研究参考", detail: "仅支持行为样本比对，不验证来源。" };
  const comparability = input.protocolComparability === "P1"
    ? { status: "strict", label: "严格可比", detail: "目标与参考使用相同请求协议、模型产品、产品面和采样问题。" }
    : input.protocolComparability === "P2"
      ? { status: "mapped", label: "映射后可比", detail: "模型产品和产品面一致，但 API 请求协议不同；按相同任务语义映射，结论等级已降低。" }
      : { status: "incomparable", label: "仅作诊断比较", detail: "产品面、参考元数据或协议条件不足；行为距离仍可展示，但不能据此确认实际上游来源。" };
  const freshness = { status: input.referenceFreshness, label: freshnessLabel(input.referenceFreshness), detail: freshnessDetail(input.referenceFreshness) };
  const modelValues = Object.keys(input.responseModels);
  const stability = modelValues.length > 1
    ? { status: "possible_multi_serving", label: "可能存在多路后端", detail: `响应中观察到 ${modelValues.length} 个不同的 model 声明值；该字段可由供应商填写，只是弱信号。` }
    : input.successRate < 0.9
      ? { status: "unstable", label: "服务波动", detail: "成功率不足，行为结论不能升级。" }
      : { status: "stable_window", label: "窗口内稳定", detail: "当前观察窗口未发现强路由变化证据。" };
  const limitations = [
    "行为相容不等于厂商认证或密码学来源证明。",
    input.protocolComparability !== "P1" ? "协议并非严格同构。" : undefined,
    !calibration ? "当前场景未校准。" : undefined,
    !input.repeatWindowConfirmed ? "尚未通过独立时间窗口复核，不能输出强异常。" : undefined,
  ].filter((value): value is string => Boolean(value));
  const conclusion: V2Conclusion = {
    frameworkVersion: V2_FRAMEWORK_VERSION,
    policyVersion: V2_POLICY_VERSION,
    behavior,
    provenance,
    stability,
    comparability,
    freshness,
    summary: behavior.status === "supported" ? "当前证据支持行为相容；来源范围以单独证据等级为准。" : behavior.status === "anomalous" ? "当前证据支持明显行为异常；不能据此命名实际替代模型。" : "当前证据不足以支持强结论，需要复核。",
    strongConclusion: support || anomaly,
    calibrationId: calibration?.id,
    limitations,
  };
  return { distance, bootstrap, genuineConformalP, impostorAcceptanceRisk, coverage, conclusion };
}

function freshnessLabel(value: string): string {
  return ({ current: "当前", usable: "可用", stale: "已老化", review_required: "需要审查", quarantined: "已隔离" } as Record<string, string>)[value] ?? value;
}
function freshnessDetail(value: string): string {
  if (value === "current") return "参考处于当前有效窗口。";
  if (value === "usable") return "参考仍可使用，但结论等级受限。";
  if (value === "stale") return "参考已老化，不能输出红色强异常。";
  if (value === "quarantined") return "参考质量异常，默认不参与正式判定。";
  return "参考状态需要人工审查。";
}

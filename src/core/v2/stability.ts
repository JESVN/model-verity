import { empiricalDistribution, jsDivergence } from "../stats/index.js";

export interface StabilityObservation {
  block: number;
  cellId: string;
  validity: "valid" | "invalid" | "refusal" | "empty" | "error";
  category?: string;
  responseModel?: string;
  attempt?: number;
  latencyMs?: number;
}

export interface StabilityAnalysis {
  status: "stable_window" | "possible_multi_serving" | "behavioral_mixture" | "conditional_fallback" | "insufficient_data";
  metadataModels: Record<string, number>;
  maxBlockDistance?: number;
  comparableBlockPairs: number;
  retryBehaviorDistance?: number;
  reasons: string[];
}

export function analyzeStability(observations: readonly StabilityObservation[], options: { mixtureThreshold?: number; minValidPerGroup?: number } = {}): StabilityAnalysis {
  const threshold = options.mixtureThreshold ?? 0.35;
  const minimum = options.minValidPerGroup ?? 5;
  const metadataModels: Record<string, number> = {};
  for (const observation of observations) {
    const model = observation.responseModel ?? "missing";
    metadataModels[model] = (metadataModels[model] ?? 0) + 1;
  }
  const blocks = [...new Set(observations.map((value) => value.block))].sort((a, b) => a - b);
  const distances: number[] = [];
  for (let leftIndex = 0; leftIndex < blocks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < blocks.length; rightIndex += 1) {
      const distance = groupedDistance(observations.filter((value) => value.block === blocks[leftIndex]), observations.filter((value) => value.block === blocks[rightIndex]), minimum);
      if (distance != null) distances.push(distance);
    }
  }
  const firstAttempts = observations.filter((value) => (value.attempt ?? 1) === 1);
  const retries = observations.filter((value) => (value.attempt ?? 1) > 1);
  const retryBehaviorDistance = groupedDistance(firstAttempts, retries, minimum);
  const maxBlockDistance = distances.length ? Math.max(...distances) : undefined;
  const reasons: string[] = [];
  if (Object.keys(metadataModels).filter((value) => value !== "missing").length > 1) reasons.push("响应中观察到多个不同的 model 声明值；该字段可由供应商填写，仅作为弱信号。");
  if (maxBlockDistance != null && maxBlockDistance >= threshold) reasons.push(`不同采样分组之间的最大行为距离为 ${maxBlockDistance.toFixed(3)}。`);
  if (retryBehaviorDistance != null && retryBehaviorDistance >= threshold) reasons.push(`重试样本与首次样本的行为距离为 ${retryBehaviorDistance.toFixed(3)}。`);
  const status = retryBehaviorDistance != null && retryBehaviorDistance >= threshold
    ? "conditional_fallback"
    : maxBlockDistance != null && maxBlockDistance >= threshold
      ? "behavioral_mixture"
      : Object.keys(metadataModels).filter((value) => value !== "missing").length > 1
        ? "possible_multi_serving"
        : distances.length
          ? "stable_window"
          : "insufficient_data";
  if (!reasons.length) reasons.push(status === "stable_window" ? "当前采样分组之间未发现超过预先设定阈值的行为变化。" : "各分组的有效样本不足，无法分析是否存在多路路由或行为混合。");
  return { status, metadataModels, maxBlockDistance, comparableBlockPairs: distances.length, retryBehaviorDistance: retryBehaviorDistance ?? undefined, reasons };
}

function groupedDistance(left: readonly StabilityObservation[], right: readonly StabilityObservation[], minimum: number): number | undefined {
  const cells = [...new Set([...left, ...right].map((value) => value.cellId))];
  const distances: number[] = [];
  for (const cellId of cells) {
    const a = empiricalDistribution(left.filter((value) => value.cellId === cellId).map(asAnswer));
    const b = empiricalDistribution(right.filter((value) => value.cellId === cellId).map(asAnswer));
    if (a.nValid < minimum || b.nValid < minimum) continue;
    distances.push(jsDivergence(a.probs, b.probs));
  }
  return distances.length ? distances.reduce((sum, value) => sum + value, 0) / distances.length : undefined;
}

function asAnswer(value: StabilityObservation): any {
  if (value.validity === "error") return { validity: "error" };
  return { raw: value.category ?? "", token: value.category ?? "", category: value.category, validity: value.validity };
}

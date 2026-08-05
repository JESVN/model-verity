export type Verdict = "likely_match" | "inconclusive" | "likely_mismatch" | "failed";

export type VerdictReason =
  | "aborted"
  | "success_rate_failed"
  | "success_rate_low"
  | "insufficient_comparable_cells"
  | "missing_score"
  | "protocol_degraded"
  | "score_match"
  | "score_mid"
  | "score_mismatch";

export interface VerdictInput {
  score?: number;
  successRate: number;
  comparableCells: number;
  plannedCells: number;
  aborted?: boolean;
  protocolDegraded?: boolean;
  tauMatch?: number;
  tauMid?: number;
  minSuccessRate?: number;
  minCellsOk?: number;
}

export interface VerdictDecision {
  verdict: Verdict;
  reason: VerdictReason;
  /** True when the score itself is in the match band but quality/protocol blocked green. */
  scoreWouldMatch: boolean;
  tauMatch: number;
  tauMid: number;
  minSuccessRate: number;
  minCellsOk: number;
}

export function classifyVerdictDetailed(input: VerdictInput): VerdictDecision {
  const tauMatch = input.tauMatch ?? 0.12;
  const tauMid = input.tauMid ?? 0.22;
  const minSuccessRate = input.minSuccessRate ?? 0.7;
  const minCellsOk = input.minCellsOk ?? Math.max(2, Math.ceil(input.plannedCells / 2));
  if (!(tauMatch >= 0 && tauMid > tauMatch && tauMid <= 1)) throw new Error("invalid thresholds");
  const scoreWouldMatch = input.score != null && input.score <= tauMatch;
  if (input.aborted) {
    return { verdict: "failed", reason: "aborted", scoreWouldMatch, tauMatch, tauMid, minSuccessRate, minCellsOk };
  }
  if (input.successRate < 0.2) {
    return { verdict: "failed", reason: "success_rate_failed", scoreWouldMatch, tauMatch, tauMid, minSuccessRate, minCellsOk };
  }
  if (input.successRate < minSuccessRate) {
    return { verdict: "inconclusive", reason: "success_rate_low", scoreWouldMatch, tauMatch, tauMid, minSuccessRate, minCellsOk };
  }
  if (input.comparableCells < minCellsOk) {
    return { verdict: "inconclusive", reason: "insufficient_comparable_cells", scoreWouldMatch, tauMatch, tauMid, minSuccessRate, minCellsOk };
  }
  if (input.score == null) {
    return { verdict: "inconclusive", reason: "missing_score", scoreWouldMatch, tauMatch, tauMid, minSuccessRate, minCellsOk };
  }
  if (input.score <= tauMatch) {
    if (input.protocolDegraded) {
      return { verdict: "inconclusive", reason: "protocol_degraded", scoreWouldMatch: true, tauMatch, tauMid, minSuccessRate, minCellsOk };
    }
    return { verdict: "likely_match", reason: "score_match", scoreWouldMatch: true, tauMatch, tauMid, minSuccessRate, minCellsOk };
  }
  if (input.score <= tauMid) {
    return { verdict: "inconclusive", reason: "score_mid", scoreWouldMatch: false, tauMatch, tauMid, minSuccessRate, minCellsOk };
  }
  return { verdict: "likely_mismatch", reason: "score_mismatch", scoreWouldMatch: false, tauMatch, tauMid, minSuccessRate, minCellsOk };
}

export function classifyVerdict(input: VerdictInput): Verdict {
  return classifyVerdictDetailed(input).verdict;
}

export function verdictHeadline(decision: Pick<VerdictDecision, "verdict" | "reason" | "scoreWouldMatch">, error?: string): string {
  switch (decision.verdict) {
    case "likely_match":
      return "相对参考，单 token 行为分布高度接近。";
    case "likely_mismatch":
      return "相对参考，行为分布明显偏离。";
    case "failed":
      return `无法完成验证：${error ?? (decision.reason === "aborted" ? "验证已取消" : "采样失败")}`;
    case "inconclusive":
    default:
      if (decision.reason === "insufficient_comparable_cells") {
        return decision.scoreWouldMatch
          ? "距离已很低，但可比 cell 不足，证据不足以给出高可信匹配。"
          : "可比 cell 不足，证据不足以形成稳定结论。";
      }
      if (decision.reason === "protocol_degraded") {
        return "距离接近匹配阈值，但 reasoning 关闭未确认，协议降级为不确定。";
      }
      if (decision.reason === "success_rate_low") {
        return "请求成功率偏低，可靠性不足，结论不确定。";
      }
      if (decision.reason === "score_mid") {
        return "相对参考有接近迹象，但不足以高置信匹配。";
      }
      return "证据不足或部分接近，建议复核。";
  }
}

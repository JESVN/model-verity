export type ScoreVisualLevel = "high" | "basic" | "review" | "low" | "unscored";

export interface ScorecardPresentation {
  label: string;
  scopeLabel?: string;
  summary?: string;
  primaryScore?: number;
  primaryScoreLabel: "行为相似评分" | "综合可信评分";
  secondaryScore?: number;
  scopeLimited: boolean;
}

export function scorecardPresentation(scorecard: any): ScorecardPresentation {
  if (!scorecard) return { label: "无法评分", primaryScoreLabel: "综合可信评分", scopeLimited: false };
  if (scorecard.scopeLabel) {
    const primaryScore = scorecard.displayScore ?? scorecard.score;
    return {
      label: scorecard.label ?? "需要复核",
      scopeLabel: scorecard.scopeLabel,
      primaryScore,
      primaryScoreLabel: scorecard.displayScoreLabel ?? "行为相似评分",
      secondaryScore: primaryScore !== scorecard.score ? scorecard.score : undefined,
      scopeLimited: true,
    };
  }
  const behavior = scorecard.dimensions?.find((item: any) => item.key === "behavior")?.score;
  const caps = Array.isArray(scorecard.caps) ? scorecard.caps as string[] : [];
  const scopeOnly = caps.length > 0 && caps.every((value) => value.includes("没有匹配校准") || value.includes("仅作诊断比较") || value.includes("已老化的研究参考"));
  const legacyScopeLimited = scorecard.band === "review"
    && ["high", "basic"].includes(scorecard.rawBand)
    && Number(behavior) >= 70
    && scopeOnly
    && caps.some((value) => value.includes("仅作诊断比较"));
  if (legacyScopeLimited) {
    return {
      label: Number(behavior) >= 90 ? "行为高度相似" : "行为较为相似",
      scopeLabel: "来源证据待复核",
      summary: Number(behavior) >= 90
        ? "本次回答分布与参考高度接近，请求质量和短时稳定性良好；当前参考只能支持行为比较，不能确认实际上游来源。"
        : "本次回答分布与参考较为接近；当前参考只能支持行为比较，仍需结合可信参考路径复核来源。",
      primaryScore: Number(behavior),
      primaryScoreLabel: "行为相似评分",
      secondaryScore: scorecard.score,
      scopeLimited: true,
    };
  }
  return { label: scorecard.label ?? "无法评分", primaryScore: scorecard.displayScore ?? scorecard.score, primaryScoreLabel: scorecard.displayScoreLabel ?? "综合可信评分", scopeLimited: false };
}

export function scoreVisualLevel(scorecard: any): ScoreVisualLevel {
  if (!scorecard) return "unscored";
  const presentation = scorecardPresentation(scorecard);
  if (presentation.scopeLimited && Number.isFinite(Number(presentation.primaryScore))) {
    const score = Number(presentation.primaryScore);
    return score >= 85 ? "high" : score >= 70 ? "basic" : score >= 50 ? "review" : "low";
  }
  return ["high", "basic", "review", "low", "unscored"].includes(scorecard.band) ? scorecard.band : "unscored";
}

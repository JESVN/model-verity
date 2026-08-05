import assert from "node:assert/strict";
import test from "node:test";
import { scorecardPresentation, scoreVisualLevel } from "../src/core/v3/presentation.js";

test("legacy 3.0 scorecards display behavioral similarity separately from P3 source scope", () => {
  const presentation = scorecardPresentation({
    policyVersion: "pamela-scorecard@3.0.0",
    score: 86.2,
    rawBand: "high",
    band: "review",
    label: "需要复核",
    dimensions: [{ key: "behavior", score: 97.9 }],
    caps: [
      "当前模型和采样条件没有匹配校准，最高为“基本可信”",
      "目标与参考仅作诊断比较，最高为“需要复核”",
    ],
  });
  assert.deepEqual(presentation, {
    label: "行为高度相似",
    scopeLabel: "来源证据待复核",
    summary: "本次回答分布与参考高度接近，请求质量和短时稳定性良好；当前参考只能支持行为比较，不能确认实际上游来源。",
    primaryScore: 97.9,
    primaryScoreLabel: "行为相似评分",
    secondaryScore: 86.2,
    scopeLimited: true,
  });
});

test("score color follows the displayed score only for source-scope-limited results", () => {
  const cases = [
    [85, "high"],
    [84.9, "basic"],
    [70, "basic"],
    [69.9, "review"],
    [50, "review"],
    [49.9, "low"],
  ] as const;
  for (const [displayScore, expected] of cases) {
    assert.equal(scoreVisualLevel({ displayScore, score: 60, band: "review", label: "测试", scopeLabel: "来源证据待复核" }), expected);
  }
  assert.equal(scoreVisualLevel({ displayScore: 98, score: 86, band: "review", label: "需要复核" }), "review", "substantive caps retain warning color");
  assert.equal(scoreVisualLevel(null), "unscored");
});

test("legacy scorecards keep review wording for substantive quality caps", () => {
  const presentation = scorecardPresentation({
    rawBand: "high",
    band: "review",
    label: "需要复核",
    dimensions: [{ key: "behavior", score: 98 }],
    caps: ["可比采样覆盖低于 75%，最高为“需要复核”"],
  });
  assert.deepEqual(presentation, { label: "需要复核", primaryScore: undefined, primaryScoreLabel: "综合可信评分", scopeLimited: false });
});

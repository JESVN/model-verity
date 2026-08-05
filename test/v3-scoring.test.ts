import assert from "node:assert/strict";
import test from "node:test";
import { computeTrustScore } from "../src/core/v3/scoring.js";

const base = { successRate: 1, coverage: 1, stabilityStatus: "stable_window", protocolComparability: "P1" as const, referenceLevel: "L2" as const, referenceFreshness: "current" as const };

test("V3 behavior score decreases monotonically with PAMELA JSD and stays bounded", () => {
  const scores = [0, .1, .2, .4, .8, 1].map((jsd) => computeTrustScore({ ...base, jsd }).dimensions[0].score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
  for (const score of scores) assert.ok(score >= 0 && score <= 100);
});

test("V3 score bands use frozen product thresholds", () => {
  // Directly exercise bands through controlled non-behavior penalties.
  const high = computeTrustScore({ ...base, jsd: 0 });
  assert.equal(high.rawBand, "high");
  assert.equal(high.band, "basic", "uncalibrated results are capped at basic");
  assert.equal(high.displayScore, high.score);
  assert.equal(high.displayScoreLabel, "综合可信评分");
  const review = computeTrustScore({ ...base, jsd: .55 });
  assert.equal(review.rawBand, "review");
  const low = computeTrustScore({ ...base, jsd: 1 });
  assert.equal(low.band, "low");
});

test("V3 critical caps preserve evidence boundaries without hiding strong behavioral similarity", () => {
  const p3 = computeTrustScore({ ...base, jsd: 0, protocolComparability: "P3" });
  assert.equal(p3.band, "review");
  assert.equal(p3.label, "行为高度相似");
  assert.equal(p3.scopeLabel, "比较范围待复核");
  assert.ok(p3.caps.some((value) => value.includes("P3") || value.includes("诊断")));
  const staleResearch = computeTrustScore({ ...base, jsd: 0, referenceLevel: "L3", referenceFreshness: "stale" });
  assert.equal(staleResearch.band, "review");
  const mixture = computeTrustScore({ ...base, jsd: 0, stabilityStatus: "behavioral_mixture" });
  assert.equal(mixture.band, "review");
  const lowQuality = computeTrustScore({ ...base, jsd: 0, successRate: .89, coverage: .74 });
  assert.equal(lowQuality.band, "review");
  const quarantined = computeTrustScore({ ...base, jsd: 0, referenceFreshness: "quarantined" });
  assert.equal(quarantined.band, "low");
});

test("V3 presents the saved GPT gateway case as high similarity with source scope pending", () => {
  const value = computeTrustScore({ ...base, jsd: 0.021452272896401607, protocolComparability: "P3", referenceLevel: "L3", referenceFreshness: "usable" });
  assert.equal(value.policyVersion, "pamela-scorecard@3.1.0");
  assert.equal(value.score, 86.2);
  assert.equal(value.displayScore, 97.9);
  assert.equal(value.displayScoreLabel, "行为相似评分");
  assert.equal(value.rawBand, "high");
  assert.equal(value.band, "review", "P3 research evidence still cannot prove source");
  assert.equal(value.label, "行为高度相似");
  assert.equal(value.scopeLabel, "来源证据待复核");
  assert.match(value.summary, /高度接近/);
  assert.ok(value.reasons.some((reason) => reason.includes("98\/100")));
});

test("V3 does not soften real quality or stability warnings", () => {
  const unstable = computeTrustScore({ ...base, jsd: 0.02, protocolComparability: "P3", referenceLevel: "L3", stabilityStatus: "behavioral_mixture" });
  assert.equal(unstable.band, "review");
  assert.equal(unstable.label, "需要复核");
  assert.equal(unstable.scopeLabel, undefined);
  const different = computeTrustScore({ ...base, jsd: 0.55, protocolComparability: "P3", referenceLevel: "L3" });
  assert.equal(different.label, "需要复核");
});

test("V3 refuses to manufacture a score when PAMELA behavior is unavailable", () => {
  const value = computeTrustScore({ ...base, jsd: undefined });
  assert.equal(value.score, undefined);
  assert.equal(value.band, "unscored");
  assert.equal(value.dimensions.length, 0);
});

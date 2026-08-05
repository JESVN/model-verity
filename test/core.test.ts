import assert from "node:assert/strict";
import test from "node:test";
import { BATTERY } from "../src/core/battery/index.js";
import { PAMELA_BATTERY, pamelaSystemPrompt } from "../src/core/battery/pamela.js";
import { normalizeAnswer } from "../src/core/normalize/index.js";
import { normalizePamelaAnswer } from "../src/core/normalize/pamela.js";
import { executePlan } from "../src/core/run/executor.js";
import { createRunPlan } from "../src/core/run/planner.js";
import { compareFingerprints, empiricalDistribution, jsDivergence, minValidForRepetitions } from "../src/core/stats/index.js";
import { classifyVerdict, classifyVerdictDetailed, verdictHeadline } from "../src/core/stats/verdict.js";

test("battery contains unique 10 x 4 cells", () => {
  assert.equal(BATTERY.length, 40);
  assert.equal(new Set(BATTERY.map((cell) => cell.id)).size, 40);
});

test("normalizes multilingual number, color and coin answers", () => {
  const cell = (id: string) => BATTERY.find((candidate) => candidate.id === id)!;
  assert.deepEqual(normalizeAnswer(cell("ar:random_number_1_10"), "٧"), { raw: "٧", token: "٧", category: "7", validity: "valid" });
  assert.equal(normalizeAnswer(cell("zh:random_number_1_100"), "三十" ).category, "30");
  assert.equal(normalizeAnswer(cell("ru:random_color"), "Синий." ).category, "blue");
  assert.equal(normalizeAnswer(cell("zh:coin_flip"), "正面" ).category, "heads");
  assert.equal(normalizeAnswer(cell("ar:coin_flip"), "كتابة" ).category, "tails");
});

test("PAMELA protocol uses exact 40-cell multilingual battery and archived normalization", () => {
  assert.equal(PAMELA_BATTERY.length, 40);
  assert.equal(new Set(PAMELA_BATTERY.map((cell) => cell.id)).size, 40);
  assert.equal(PAMELA_BATTERY.find((cell) => cell.id === "en:num100-random")?.prompt, "Name a random number between 1 and 100.");
  assert.match(pamelaSystemPrompt("zh"), /只用一个词或一个数字回答/);
  const cell = (id: string) => PAMELA_BATTERY.find((candidate) => candidate.id === id)!;
  assert.equal(normalizePamelaAnswer(cell("ar:num10-random"), "٧").category, "7");
  assert.equal(normalizePamelaAnswer(cell("zh:num100-random"), "四十二").category, "42");
  assert.equal(normalizePamelaAnswer(cell("ru:coin-flip"), "Орёл.").category, "h");
  assert.equal(normalizePamelaAnswer(cell("en:word-random"), "this is a full sentence").validity, "invalid");
});

test("JSD is symmetric, bounded and zero for identical distributions", () => {
  assert.equal(jsDivergence({ a: 1 }, { a: 1 }), 0);
  assert.equal(jsDivergence({ a: 1 }, { b: 1 }), 1);
  const a = jsDivergence({ a: 0.75, b: 0.25 }, { a: 0.25, b: 0.75 });
  const b = jsDivergence({ a: 0.25, b: 0.75 }, { a: 0.75, b: 0.25 });
  assert.ok(a > 0 && a < 1);
  assert.equal(a, b);
});

test("planner is deterministic and profile budgets are correct", () => {
  const a = createRunPlan("audit", "seed-1");
  const b = createRunPlan("audit", "seed-1");
  assert.deepEqual(a.cells.map((cell) => cell.id), b.cells.map((cell) => cell.id));
  assert.deepEqual(a.samples.map((sample) => sample.id), b.samples.map((sample) => sample.id));
  assert.equal(a.cells.length, 8);
  assert.equal(a.samples.length, 120);
  assert.equal(new Set(a.cells.map((cell) => cell.language)).size, 4);
  const pamela = createRunPlan("audit", "pamela", { battery: PAMELA_BATTERY });
  assert.equal(pamela.cells.length, 8);
  assert.equal(new Set(pamela.cells.map((cell) => cell.language)).size, 4);
  assert.ok(pamela.cells.every((cell) => cell.id.includes("-")));
});

test("executor honors concurrency and retries retryable errors", async () => {
  const plan = createRunPlan("quick", "executor", { repetitions: 2 });
  let active = 0;
  let maxActive = 0;
  const attempts = new Map<string, number>();
  const result = await executePlan(plan.samples, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active -= 1;
    const count = (attempts.get(item.id) ?? 0) + 1;
    attempts.set(item.id, count);
    if (count === 1) throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 1 });
    return item.id;
  }, { concurrency: 3, retry: { baseDelayMs: 1, maxDelayMs: 2, jitter: 0 } });
  assert.equal(maxActive, 3);
  assert.equal(result.results.size, plan.samples.length);
  assert.equal(result.errors.size, 0);
  assert.deepEqual(
    plan.samples.map((item) => attempts.get(item.id)),
    plan.samples.map(() => 2),
  );
});

test("circuit breaker accounts for every unprocessed sample", async () => {
  const plan = createRunPlan("quick", "circuit", { repetitions: 2 });
  const result = await executePlan(plan.samples, async () => {
    throw Object.assign(new Error("down"), { status: 500 });
  }, { concurrency: 2, circuitBreakAfter: 2, retry: { maxAttempts: 1 } });
  assert.equal(result.results.size, 0);
  assert.equal(result.errors.size, plan.samples.length);
});

test("mock fingerprint comparison produces match and mismatch verdicts", () => {
  const answer = (category: string) => ({ raw: category, token: category, category, validity: "valid" as const });
  const ref = empiricalDistribution(Array.from({ length: 15 }, (_, i) => answer(i < 10 ? "blue" : "red")));
  const same = empiricalDistribution(Array.from({ length: 15 }, (_, i) => answer(i < 10 ? "blue" : "red")));
  const other = empiricalDistribution(Array.from({ length: 15 }, () => answer("green")));
  const match = compareFingerprints({ cells: { c: ref } }, { cells: { c: same } }, ["c"], 10);
  const mismatch = compareFingerprints({ cells: { c: ref } }, { cells: { c: other } }, ["c"], 10);
  assert.equal(classifyVerdict({ score: match.score, successRate: 1, comparableCells: 1, plannedCells: 1, minCellsOk: 1 }), "likely_match");
  assert.equal(classifyVerdict({ score: mismatch.score, successRate: 1, comparableCells: 1, plannedCells: 1, minCellsOk: 1 }), "likely_mismatch");
});

test("minValidForRepetitions adapts to repetition budget", () => {
  assert.equal(minValidForRepetitions(10), 7);
  assert.equal(minValidForRepetitions(15), 10);
  assert.equal(minValidForRepetitions(20), 10);
  assert.equal(minValidForRepetitions(7), 5);
  assert.equal(minValidForRepetitions(5), 5);
  assert.equal(minValidForRepetitions(3), 5);
  assert.throws(() => minValidForRepetitions(0), /invalid/);
  assert.throws(() => minValidForRepetitions(-1), /invalid/);
});

test("classifyVerdictDetailed provides reason and scoreWouldMatch", () => {
  const match = classifyVerdictDetailed({ score: 0.05, successRate: 1, comparableCells: 4, plannedCells: 4 });
  assert.equal(match.verdict, "likely_match");
  assert.equal(match.reason, "score_match");
  assert.equal(match.scoreWouldMatch, true);

  const mid = classifyVerdictDetailed({ score: 0.15, successRate: 1, comparableCells: 4, plannedCells: 4 });
  assert.equal(mid.verdict, "inconclusive");
  assert.equal(mid.reason, "score_mid");
  assert.equal(mid.scoreWouldMatch, false);

  const lowCells = classifyVerdictDetailed({ score: 0.05, successRate: 1, comparableCells: 1, plannedCells: 4 });
  assert.equal(lowCells.verdict, "inconclusive");
  assert.equal(lowCells.reason, "insufficient_comparable_cells");
  assert.equal(lowCells.scoreWouldMatch, true);

  const degraded = classifyVerdictDetailed({ score: 0.05, successRate: 1, comparableCells: 4, plannedCells: 4, protocolDegraded: true });
  assert.equal(degraded.verdict, "inconclusive");
  assert.equal(degraded.reason, "protocol_degraded");
  assert.equal(degraded.scoreWouldMatch, true);

  const failed = classifyVerdictDetailed({ score: 0.05, successRate: 0.1, comparableCells: 4, plannedCells: 4 });
  assert.equal(failed.verdict, "failed");
  assert.equal(failed.reason, "success_rate_failed");

  assert.equal(verdictHeadline(match), "相对参考，单 token 行为分布高度接近。");
  assert.equal(verdictHeadline(lowCells), "距离已很低，但可比 cell 不足，证据不足以给出高可信匹配。");
  assert.equal(verdictHeadline(mid), "相对参考有接近迹象，但不足以高置信匹配。");
});

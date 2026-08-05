import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChallengeManifest } from "../src/core/v2/challenges.js";
import { artifactHash, bootstrapMeanInterval, empiricalTailProbability, validateCalibrationArtifact } from "../src/core/v2/calibration.js";
import { evaluateEvidence } from "../src/core/v2/evidence.js";
import { analyzeStability } from "../src/core/v2/stability.js";
import { enforceExploratoryPolicy } from "../src/core/v2/policy.js";
import { referenceFreshnessAt } from "../src/core/v2/reference-freshness.js";
import { PAMELA_BATTERY } from "../src/core/battery/pamela.js";
import { CredentialSessionStore } from "../src/server/credential-sessions.js";
import type { CalibrationArtifact } from "../src/core/v2/types.js";
import { Repository } from "../src/server/db.js";
import { readFile } from "node:fs/promises";

function calibration(): CalibrationArtifact {
  const unsigned = {
    id: "cal-1", version: "1", frameworkVersion: "service-claims@2.0.0", vendor: "OpenAI", product: "GPT-X", surface: "api" as const,
    protocols: ["openai-compatible" as const], profile: "quick", cellIds: ["c"], sampleSize: 30,
    genuineDistances: Array.from({ length: 199 }, (_, index) => index / 2000),
    impostorDistances: Array.from({ length: 199 }, (_, index) => 0.5 + index / 1000),
    supportMax: 0.1, anomalyMin: 0.4, falseAcceptRate: 0.005, falseRejectRate: 0.005, minCoverage: 1,
    createdAt: "2026-07-28T00:00:00.000Z", source: "frozen-test",
  };
  return { ...unsigned, manifestHash: artifactHash(unsigned) };
}

const cell = (category: string) => ({ counts: { [category]: 20 }, probs: { [category]: 1 }, nValid: 20, nInvalid: 0, nRefusal: 0, nEmpty: 0, nError: 0 });

test("v2 challenge manifest is deterministic, paired and byte-identical by hash", () => {
  const a = createChallengeManifest({ seed: "fixed", cells: 4, repetitions: 5, concurrency: 2, protocolComparability: "P1" });
  const b = createChallengeManifest({ seed: "fixed", cells: 4, repetitions: 5, concurrency: 2, protocolComparability: "P1" });
  assert.equal(a.items.length, 20);
  assert.equal(a.contentHash, b.contentHash);
  assert.deepEqual(a.items, b.items);
  assert.equal(new Set(a.items.map((item) => item.cellId.split(":")[0])).size, 4);
  for (const item of a.items) assert.equal(item.requestHash, createHash("sha256").update(`${item.system}\0${item.user}`).digest("hex"));
});

test("built-in screening can use exact fixed PAMELA prompts while paired manifests retain markers", () => {
  const fixed = createChallengeManifest({ seed: "fixed-prompts", cells: 4, repetitions: 5, concurrency: 1, protocolComparability: "P3", promptMode: "fixed" });
  const marked = createChallengeManifest({ seed: "fixed-prompts", cells: 4, repetitions: 5, concurrency: 1, protocolComparability: "P1", promptMode: "marked" });
  assert.equal(fixed.version, "pamela-challenge@2");
  assert.equal(fixed.promptMode, "fixed");
  assert.equal(marked.promptMode, "marked");
  for (const item of fixed.items) assert.equal(item.user, PAMELA_BATTERY.find((cell) => cell.id === item.cellId)?.prompt);
  assert.ok(marked.items.every((item) => item.user.includes("Request marker:")));
  assert.notEqual(fixed.contentHash, marked.contentHash);
});

test("rolling reference freshness follows the frozen 14/45-day policy", () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  assert.equal(referenceFreshnessAt("2026-07-16T00:00:00.000Z", now), "current");
  assert.equal(referenceFreshnessAt("2026-07-15T00:00:00.000Z", now), "usable");
  assert.equal(referenceFreshnessAt("2026-06-15T00:00:00.000Z", now), "usable");
  assert.equal(referenceFreshnessAt("2026-06-14T23:59:59.999Z", now), "stale");
  assert.equal(referenceFreshnessAt("invalid", now), "stale");
  assert.equal(referenceFreshnessAt("2026-07-31T00:00:00.000Z", now), "stale");
});

test("v2 calibration helpers are deterministic and enforce frozen 1% targets", () => {
  const artifact = calibration();
  assert.equal(validateCalibrationArtifact(artifact), artifact);
  assert.equal(empiricalTailProbability([0.1, 0.2, 0.3], 0.2), 0.75);
  assert.deepEqual(bootstrapMeanInterval([0.1, 0.2, 0.3], { iterations: 100, seed: "x" }), bootstrapMeanInterval([0.1, 0.2, 0.3], { iterations: 100, seed: "x" }));
  assert.throws(() => validateCalibrationArtifact({ ...artifact, falseRejectRate: 0.02 }), /1%/);
});

test("v2 strong conclusions require calibration, P1 and repeated anomaly window", () => {
  const artifact = calibration();
  const support = evaluateEvidence({ reference: { cells: { c: cell("a") } }, candidate: { cells: { c: cell("a") } }, cellIds: ["c"], minValid: 5, calibration: artifact, protocolComparability: "P1", referenceLevel: "L1", referenceFreshness: "current", successRate: 1, responseModels: { "gpt-x": 20 } });
  assert.equal(support.conclusion.behavior.status, "supported");
  assert.equal(support.conclusion.strongConclusion, true);
  const crossSurface = evaluateEvidence({ reference: { cells: { c: cell("a") } }, candidate: { cells: { c: cell("b") } }, cellIds: ["c"], minValid: 5, calibration: artifact, protocolComparability: "P2", referenceLevel: "L1", referenceFreshness: "current", successRate: 1, responseModels: {} ,repeatWindowConfirmed:true});
  assert.equal(crossSurface.conclusion.behavior.status, "review");
  assert.equal(crossSurface.conclusion.strongConclusion, false);
  const noCalibration = evaluateEvidence({ reference: { cells: { c: cell("a") } }, candidate: { cells: { c: cell("a") } }, cellIds: ["c"], minValid: 5, protocolComparability: "P1", referenceLevel: "L3", referenceFreshness: "stale", successRate: 1, responseModels: {} });
  assert.equal(noCalibration.conclusion.behavior.status, "uncalibrated");
});

test("exploratory production policy always removes strong conclusions", () => {
  const conclusion:any={frameworkVersion:"x",policyVersion:"x",behavior:{status:"supported",label:"强支持",detail:"x"},provenance:{},stability:{},comparability:{},freshness:{},summary:"x",strongConclusion:true,limitations:[]};
  const value=enforceExploratoryPolicy(conclusion);
  assert.equal(value.behavior.status,"compatible_signal");assert.equal(value.strongConclusion,false);assert.equal(value.policyVersion,"exploratory-only@1");
});

test("temporary credentials are memory-only, role-bound and deleted with run", () => {
  const store=new CredentialSessionStore();const created=store.create({endpointRole:"reference",secret:"top-secret",ttlMs:1000});store.bind(created.id,"run-1");assert.equal(store.get(created.id,"run-1","reference"),"top-secret");assert.equal(store.get(created.id,"run-1","target"),undefined);store.deleteRun("run-1");assert.equal(store.count(),0);
});

test("v2 repository atomically enforces request and token budgets", async () => {
  const dir=await mkdtemp(join(tmpdir(),"mv-budget-"));try{const repo=new Repository(dir);const p=repo.saveProvider({name:"P",protocol:"openai-compatible",baseUrl:"http://localhost",models:["m"],role:"audit",secretRef:"x",headers:{}});const auth=repo.createBudgetAuthorization({limits:{maxEndpointRequests:2,maxInputTokens:10,maxOutputTokens:5},allowed:{providerIds:[p.id],models:["m"]},expiresAt:"2099-01-01T00:00:00Z"});repo.reserveBudgetRequest(auth.id,p.id,"m");repo.reserveBudgetRequest(auth.id,p.id,"m");assert.throws(()=>repo.reserveBudgetRequest(auth.id,p.id,"m"),/exhausted/);repo.accountBudgetTokens(auth.id,5,1);assert.throws(()=>repo.accountBudgetTokens(auth.id,6,1),/token stop/);repo.close();}finally{await rm(dir,{recursive:true,force:true});}
});

test("reference governance is immutable and append-only", async()=>{
 const dir=await mkdtemp(join(tmpdir(),"mv-governance-"));try{const repo=new Repository(dir);const cohort=repo.createReferenceCohortV2({label:"9router trusted",vendor:"OpenAI",product:"GPT-5.6-sol",surface:"api",status:"active"});const version=repo.saveReferenceVersionV2({cohortId:cohort.id,level:"L2",identity:{vendor:"OpenAI",product:"GPT-5.6-sol",surface:"api"},protocol:"openai-responses",collectedAt:"2026-07-28T00:00:00.000Z",lastConfirmedAt:"2026-07-28T00:00:00.000Z",freshnessStatus:"current",qualityStatus:"approved",manifestHash:"a".repeat(64),fingerprint:{cells:{}}});repo.addReferenceGovernanceEvent(version.id,"review_required",{reason:"quality"});repo.addReferenceGovernanceEvent(version.id,"marked_stale",{reason:"age"});const stale=repo.getReferenceVersionV2(version.id);assert.equal(stale?.freshnessStatus,"stale");assert.equal(stale?.qualityStatus,"approved");assert.deepEqual(repo.listReferenceGovernanceEvents(version.id).map((event)=>event.eventType),["review_required","marked_stale"]);repo.close();}finally{await rm(dir,{recursive:true,force:true});}
});

test("v2 stability analysis detects block mixtures and retry-conditional fallback", () => {
  const values = (block: number, category: string, attempt = 1) => Array.from({ length: 6 }, () => ({ block, cellId: "en:coin-flip", validity: "valid" as const, category, responseModel: "declared", attempt }));
  const stable = analyzeStability([...values(0, "heads"), ...values(1, "heads")]);
  assert.equal(stable.status, "stable_window");
  const mixture = analyzeStability([...values(0, "heads"), ...values(1, "tails")]);
  assert.equal(mixture.status, "behavioral_mixture");
  const fallback = analyzeStability([...values(0, "heads"), ...values(0, "tails", 2)]);
  assert.equal(fallback.status, "conditional_fallback");
});

test("M8 runner treats token stop-limit breaches as fatal budget errors, not endpoint observations", async () => {
  const source = await readFile(new URL("../scripts/run-m8-validation.ts", import.meta.url), "utf8");
  assert.match(source, /if\(error instanceof BudgetExceededError\)throw error/);
  assert.match(source, /throw new BudgetExceededError\(`\$\{provider\} input token stop limit exceeded/);
  assert.doesNotMatch(source, /catch\(error:any\)\{return \{provider:[^}]+errorCategory:classifyError\(error\)/s);
});

test("v2 repository schema persists immutable evidence without modifying legacy tables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mv-v2-db-"));
  try {
    const repo = new Repository(dir);
    const provider = repo.saveProvider({ name: "Proxy", protocol: "openai-compatible", baseUrl: "http://localhost/v1", models: ["x"], role: "audit", secretRef: "file:x", headers: {} });
    const run = repo.createV2Run({ mode: "screening", providerId: provider.id, model: "x", profile: "quick", protocolComparability: "P3", referenceLevel: "L3", identity: { declared: { vendor: "unknown", product: "x", surface: "unknown" } }, budget: { maxPairs: 20, maxEndpointRequests: 20, maxAttemptsPerEndpoint: 1, expiresAt: "2099-01-01T00:00:00.000Z" } });
    const manifest = createChallengeManifest({ seed: "db", cells: 4, repetitions: 5, concurrency: 1, protocolComparability: "P3" });
    repo.saveV2Manifest(run.id, manifest);
    const blockId = repo.saveV2Block(run.id, 0, 20);
    const observationId = repo.saveV2Observation({ runId: run.id, blockId, pairId: "p", challengeId: "c", endpointRole: "proxy", cellId: "en:coin-flip", repetition: 0, requestHash: "h", validity: "valid", normalizedCategory: "h", reportedModel: "x", latencyMs: 1, usage: {}, protocolDegraded: false, pairCompleteness: "screening", timeGapMs: 0 });
    repo.saveV2Attempt(observationId, { attemptIndex: 1, status: "succeeded", httpStatus: 200, errorCategory: null, latencyMs: 1, reportedModel: "x", usage: {}, visibleAnswer: "h", rawHash: "h", startedAt: "2026-01-01", finishedAt: "2026-01-01" });
    repo.saveV2Evidence(run.id, { conclusion: { frameworkVersion: "service-claims@2.0.0" } }, { behavior: "review" });
    assert.equal(repo.listV2Runs().length, 1);
    assert.equal(repo.v2Observations(run.id).length, 1);
    assert.equal(repo.listRuns().length, 0);
    repo.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

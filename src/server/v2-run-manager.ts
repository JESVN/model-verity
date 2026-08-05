import { createHash } from "node:crypto";
import { adapterFor } from "../core/adapters/registry.js";
import type { AdapterId } from "../core/adapters/types.js";
import { PAMELA_BATTERY } from "../core/battery/pamela.js";
import { normalizePamelaAnswer } from "../core/normalize/pamela.js";
import { empiricalDistribution, minValidForRepetitions, type CellDistribution } from "../core/stats/index.js";
import { createChallengeManifest } from "../core/v2/challenges.js";
import { evaluateEvidence } from "../core/v2/evidence.js";
import { analyzeStability } from "../core/v2/stability.js";
import { enforceExploratoryPolicy } from "../core/v2/policy.js";
import { referenceFreshnessAt } from "../core/v2/reference-freshness.js";
import { computeTrustScore } from "../core/v3/scoring.js";
import type { CalibrationArtifact, V2EndpointInput } from "../core/v2/types.js";
import { Repository, type V2RunRecord } from "./db.js";
import { SecretStore } from "./secrets.js";
import { CredentialSessionStore } from "./credential-sessions.js";
import { ReportBindingStore } from "./report-binding.js";
import { getBuiltinReference } from "./builtin-library.js";

interface V2SampleValue { validity: "valid" | "invalid" | "refusal" | "empty" | "error"; category?: string; latencyMs?: number; responseModel?: string; reasoningDisabled?: boolean; usage?: {inputTokens?:number;outputTokens?:number}; error?: string }

export class V2RunManager {
  private controllers = new Map<string, AbortController>();
  constructor(private repo: Repository, private secrets: SecretStore, private credentialSessions?: CredentialSessionStore, private reportBindings?:ReportBindingStore) {}

  launch(id: string): void {
    if (this.controllers.has(id)) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.execute(id, controller).finally(() => this.controllers.delete(id));
  }

  async cancel(id: string): Promise<V2RunRecord> {
    const run = this.repo.getV2Run(id);
    if (!run) throw new Error("v2 run not found");
    if (!["queued", "running"].includes(run.status)) return run;
    this.repo.updateV2Run(id, { abortRequested: true });
    this.controllers.get(id)?.abort();
    const cancelled=this.repo.updateV2Run(id, { status: "cancelled", finishedAt: new Date().toISOString(), error: "cancelled by user" });
    this.credentialSessions?.deleteRun(id);
    return cancelled;
  }

  async shutdown(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    while (this.controllers.size) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private async execute(id: string, controller: AbortController): Promise<void> {
    const run = this.repo.getV2Run(id);
    if (!run) return;
    try {
      this.repo.updateV2Run(id, { status: "running", phase: "sampling", startedAt: new Date().toISOString(), progress: 0 });
      const provider = this.repo.getProvider(run.providerId);
      if (!provider) throw new Error("provider not found");
      const proxyCredentialRole = run.mode === "reference_enrollment" ? "reference" : "target";
      const proxyCredentialSessionId = run.budget?.targetCredentialSessionId ?? run.budget?.referenceCredentialSessionId;
      const proxyKey = proxyCredentialSessionId
        ? this.credentialSessions?.get(proxyCredentialSessionId,run.id,proxyCredentialRole)
        : await this.secrets.get(provider.secretRef);
      if (!proxyKey) throw new Error("provider API key unavailable");
      const budget = run.budget as { maxPairs?: number; maxEndpointRequests?: number; maxAttemptsPerEndpoint?: number; expiresAt?: string };
      if (budget.expiresAt && Date.parse(budget.expiresAt) < Date.now()) throw new Error("budget authorization expired");
      const isPaired = run.mode === "paired";
      const isReferenceEnrollment = run.mode === "reference_enrollment";
      const targetProtocol = adapterProtocol(run.identity?.observed?.targetProtocol, provider.protocol);
      const referenceProvider = isPaired && run.referenceProviderId ? this.repo.getProvider(run.referenceProviderId) : undefined;
      const referenceProtocol = referenceProvider ? adapterProtocol(run.identity?.observed?.referenceProtocol, referenceProvider.protocol) : undefined;
      const referenceKey = run.budget?.referenceCredentialSessionId
        ? this.credentialSessions?.get(run.budget.referenceCredentialSessionId,run.id,"reference")
        : referenceProvider ? await this.secrets.get(referenceProvider.secretRef) : null;
      if (isPaired && (!referenceProvider || !referenceKey || !run.referenceModel)) throw new Error("first-party reference endpoint is required for paired verification");
      const bindingStore=this.reportBindings;
      if(bindingStore){
        const targetBinding=bindingStore.bind(provider,proxyKey,run.model,targetProtocol);
        this.repo.saveV2Endpoint({runId:run.id,role:isReferenceEnrollment?"reference":"target",providerId:provider.id,...targetBinding,protocol:targetProtocol,model:run.model,identity:run.identity?.declared??{}});
        if(isPaired&&referenceProvider&&referenceKey&&run.referenceModel&&referenceProtocol){const referenceBinding=bindingStore.bind(referenceProvider,referenceKey,run.referenceModel,referenceProtocol);this.repo.saveV2Endpoint({runId:run.id,role:"reference",providerId:referenceProvider.id,...referenceBinding,protocol:referenceProtocol,model:run.referenceModel,identity:run.identity?.reference??{}});}
      }
      const repetitions = run.profile === "quick" ? 5 : run.profile === "full" ? 15 : 10;
      const cells = run.profile === "quick" ? 4 : run.profile === "full" ? 16 : 8;
      // Candidate runner intentionally uses one active pair. The manifest records
      // actual scheduling behavior; higher pair concurrency requires calibration.
      // Built-in PAMELA distributions were collected with the exact fixed paper
      // prompts. Markers remain enabled for paired and self-built-reference flows,
      // where both sides or the stored reference use the same marked protocol.
      const usesBuiltinReference = !isPaired && !isReferenceEnrollment && Boolean(run.referenceId && getBuiltinReference(run.referenceId));
      const promptMode = usesBuiltinReference ? "fixed" : "marked";
      const manifest = createChallengeManifest({ cells, repetitions, concurrency: 1, protocolComparability: run.protocolComparability as any, promptMode });
      this.repo.saveV2Manifest(run.id, manifest);
      const plannedItems=manifest.items.slice(0,Math.min(manifest.items.length,budget.maxPairs??manifest.items.length));
      const blockId = this.repo.saveV2Block(run.id, 0, plannedItems.length);
      const budgetAuthorizationId=typeof run.budget?.authorizationId==="string"?run.budget.authorizationId:undefined;
      const maxRequests = Math.min(budget.maxEndpointRequests ?? 200, plannedItems.length * (isPaired ? 2 : 1) * (budget.maxAttemptsPerEndpoint ?? 1));
      let requestCount = 0;
      let completed = 0;
      let failed = 0;
      let targetCompleted=0;
      let targetFailed=0;
      let processedPairs=0;
      const proxyByCell = new Map<string, V2SampleValue[]>();
      const refByCell = new Map<string, V2SampleValue[]>();
      const responseModels: Record<string, number> = {};
      for (const item of plannedItems) {
        if (controller.signal.aborted) return;
        if (requestCount >= maxRequests || (isPaired&&requestCount+2>maxRequests)) break;
        let proxyStart=0,referenceStart=0;
        const runProxy=async()=>{if(budgetAuthorizationId)this.repo.reserveBudgetRequest(budgetAuthorizationId,provider.id,run.model);proxyStart=performance.now();const value=await this.observe({ endpoint: { baseUrl: provider.baseUrl, apiKey: proxyKey, protocol: targetProtocol, model: run.model, headers: provider.headers }, item, signal: controller.signal });if(budgetAuthorizationId)this.repo.accountBudgetTokens(budgetAuthorizationId,value.usage?.inputTokens??0,value.usage?.outputTokens??0);return value;};
        const runReference=async()=>{if(!referenceProvider||!referenceKey||!referenceProtocol||!run.referenceModel)throw new Error("reference unavailable");if(budgetAuthorizationId)this.repo.reserveBudgetRequest(budgetAuthorizationId,referenceProvider.id,run.referenceModel);referenceStart=performance.now();const value=await this.observe({ endpoint: { baseUrl: referenceProvider.baseUrl, apiKey: referenceKey, protocol: referenceProtocol, model: run.referenceModel, headers: referenceProvider.headers }, item, signal: controller.signal });if(budgetAuthorizationId)this.repo.accountBudgetTokens(budgetAuthorizationId,value.usage?.inputTokens??0,value.usage?.outputTokens??0);return value;};
        let proxy:V2SampleValue;let ref:V2SampleValue|undefined;let firstRole="target";
        if(isPaired&&requestCount+2<=maxRequests){const referenceFirst=seededOrder(`${manifest.seed}:${item.pairId}`);firstRole=referenceFirst?"reference":"target";const values=await Promise.all(referenceFirst?[runReference(),runProxy()]:[runProxy(),runReference()]);ref=referenceFirst?values[0]:values[1];proxy=referenceFirst?values[1]:values[0];requestCount+=2;push(refByCell,item.cellId,ref);}else{proxy=await runProxy();requestCount+=1;}
        targetCompleted += proxy.validity === "error" ? 0 : 1;
        targetFailed += proxy.validity === "error" ? 1 : 0;
        completed += (proxy.validity === "error" ? 0 : 1)+(ref&&ref.validity!=="error"?1:0);
        failed += (proxy.validity === "error" ? 1 : 0)+(ref&&ref.validity==="error"?1:0);
        processedPairs+=1;
        if (proxy.responseModel) responseModels[proxy.responseModel] = (responseModels[proxy.responseModel] ?? 0) + 1;
        push(proxyByCell, item.cellId, proxy);
        const timeGapMs = isPaired ? Math.abs(proxyStart-referenceStart) : 0;
        const proxyObsId = this.repo.saveV2Observation({ runId: run.id, blockId, pairId: item.pairId, challengeId: item.challengeId, endpointRole: isReferenceEnrollment ? "reference" : "proxy", cellId: item.cellId, repetition: item.repetition, requestHash: item.requestHash, validity: proxy.validity, normalizedCategory: proxy.category, reportedModel: proxy.responseModel, latencyMs: proxy.latencyMs, usage: {...proxy.usage,firstRole}, protocolDegraded: proxy.reasoningDisabled === false, pairCompleteness: isPaired ? (ref ? "complete" : "incomplete_pair") : isReferenceEnrollment ? "reference_enrollment" : "screening", timeGapMs });
        this.repo.saveV2Attempt(proxyObsId, { attemptIndex: 1, status: proxy.validity === "error" ? "failed" : "succeeded", httpStatus: null, errorCategory: proxy.error, latencyMs: proxy.latencyMs, reportedModel: proxy.responseModel, usage: proxy.usage, visibleAnswer: proxy.category, rawHash: proxy.category ? createHash("sha256").update(proxy.category).digest("hex") : null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
        if (ref) {
          const refObsId = this.repo.saveV2Observation({ runId: run.id, blockId, pairId: item.pairId, challengeId: item.challengeId, endpointRole: "reference", cellId: item.cellId, repetition: item.repetition, requestHash: item.requestHash, validity: ref.validity, normalizedCategory: ref.category, reportedModel: ref.responseModel, latencyMs: ref.latencyMs, usage: ref.usage, protocolDegraded: ref.reasoningDisabled === false, pairCompleteness: "complete", timeGapMs });
          this.repo.saveV2Attempt(refObsId, { attemptIndex: 1, status: ref.validity === "error" ? "failed" : "succeeded", httpStatus: null, errorCategory: ref.error, latencyMs: ref.latencyMs, reportedModel: ref.responseModel, usage: ref.usage, visibleAnswer: ref.category, rawHash: ref.category ? createHash("sha256").update(ref.category).digest("hex") : null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
        }
        this.repo.updateV2Run(run.id, { progress: requestCount / maxRequests, successCount: completed, failCount: failed });
      }
      this.repo.finishV2Block(blockId, processedPairs, processedPairs<plannedItems.length ? "budget_exhausted" : "completed");
      const proxyFingerprint = { cells: mapDistribution(proxyByCell) };
      if (isReferenceEnrollment) {
        const uniqueCellIds=[...new Set(manifest.items.map((item)=>item.cellId))];
        const minimumValid=minValidForRepetitions(repetitions);
        const usableCells=uniqueCellIds.filter((cellId)=>Number(proxyFingerprint.cells[cellId]?.nValid??0)>=minimumValid);
        const successRate=processedPairs ? targetCompleted/processedPairs : 0;
        const degradedCount=this.repo.v2Observations(run.id).filter((value)=>Boolean(value.protocol_degraded)).length;
        const requiredCells=Math.max(4,Math.ceil(uniqueCellIds.length*.75));
        if(processedPairs!==plannedItems.length)throw new Error("reference collection did not complete the frozen manifest");
        if(successRate<.9)throw new Error(`reference quality gate failed: success rate ${(successRate*100).toFixed(1)}% is below 90%`);
        if(usableCells.length<requiredCells)throw new Error(`reference quality gate failed: ${usableCells.length}/${uniqueCellIds.length} usable cells; ${requiredCells} required`);
        if(degradedCount)throw new Error("reference quality gate failed: reasoning disablement was not confirmed");
        const identity=run.identity?.declared??{vendor:"unknown",product:run.model,surface:"unknown"};
        const collectedAt=new Date().toISOString();
        this.repo.publishReferenceEnrollment({runId:run.id,cohort:{label:String(run.identity?.enrollmentLabel??`${provider.name} · ${run.model}`),vendor:String(identity.vendor??"unknown"),product:String(identity.product??run.model),surface:String(identity.surface??"unknown")},version:{level:run.referenceLevel,identity:{...identity,providerId:provider.id,model:run.model},protocol:targetProtocol,collectedAt,manifestHash:manifest.contentHash,fingerprint:proxyFingerprint},quality:{successRate,usableCells:usableCells.length,plannedCells:uniqueCellIds.length,minimumValidPerCell:minimumValid,protocolDegraded:false},manifest:{id:manifest.contentHash,version:manifest.version,promptMode:manifest.promptMode,pairs:processedPairs,plannedPairs:plannedItems.length,requestsUsed:requestCount,maxRequests}});
        return;
      }
      const screeningVersion = !isPaired && run.referenceId ? this.repo.getReferenceVersionV2(run.referenceId) : undefined;
      const screeningReference = !isPaired && run.referenceId
        ? this.repo.getReference(run.referenceId) ?? getBuiltinReference(run.referenceId) ?? screeningVersion
        : undefined;
      if (!isPaired && !screeningReference) throw new Error("screening reference fingerprint is required");
      const referenceFingerprint = isPaired
        ? { cells: mapDistribution(refByCell) }
        : screeningReference!.fingerprint as { cells: Record<string, CellDistribution> };
      const identity = run.identity?.declared ?? { vendor: "unknown", product: run.model, surface: "unknown" };
      const calibration = this.repo.findCalibration(identity.vendor, identity.product, identity.surface, run.profile)?.artifact as CalibrationArtifact | undefined;
      const referenceFreshness = screeningVersion?.freshnessStatus as any
        ?? (isPaired ? "current" : screeningReference && "enrolledAt" in screeningReference
          ? referenceFreshnessAt(String(screeningReference.enrolledAt))
          : calibration ? "current" : "stale");
      const evidence = evaluateEvidence({ reference: referenceFingerprint, candidate: proxyFingerprint, cellIds: manifest.items.map((item) => item.cellId).filter((value, index, array) => array.indexOf(value) === index), minValid: minValidForRepetitions(repetitions), calibration, protocolComparability: run.protocolComparability as any, referenceLevel: run.referenceLevel as any, referenceFreshness, successRate: processedPairs ? targetCompleted / processedPairs : 0, responseModels });
      const stability = analyzeStability([...proxyByCell].flatMap(([cellId, values]) => values.map((value, index) => ({ block: Math.floor(index / Math.max(1, Math.ceil(values.length / 4))), cellId, validity: value.validity, category: value.category, responseModel: value.responseModel, attempt: 1, latencyMs: value.latencyMs }))), { minValidPerGroup: 2 });
      evidence.conclusion.stability = { status: stability.status, label: stability.status === "stable_window" ? "本次窗口内稳定" : stability.status === "insufficient_data" ? "数据不足" : stability.status === "possible_multi_serving" ? "可能存在多路后端" : stability.status === "conditional_fallback" ? "可能存在条件式备用路由" : "检测到分组行为变化", detail: stability.reasons.join("；") };
      evidence.conclusion = enforceExploratoryPolicy(evidence.conclusion);
      const successRate = processedPairs ? targetCompleted / processedPairs : 0;
      const scorecard = computeTrustScore({
        jsd: evidence.distance.score,
        successRate,
        coverage: evidence.coverage,
        stabilityStatus: stability.status,
        protocolComparability: run.protocolComparability as any,
        referenceLevel: run.referenceLevel as any,
        referenceFreshness: evidence.conclusion.freshness.status as any,
        calibration,
        genuineConformalP: evidence.genuineConformalP,
        impostorAcceptanceRisk: evidence.impostorAcceptanceRisk,
      });
      this.repo.saveV2Evidence(run.id, { ...evidence, stability, scorecard }, { ...evidence.conclusion, scorecard }, calibration?.id);
      const startGaps=this.repo.v2Observations(run.id).filter((value)=>value.endpoint_role==="proxy").map((value)=>Number(value.time_gap_ms)).filter(Number.isFinite).sort((a,b)=>a-b);
      this.repo.updateV2Run(run.id, { status: "completed", phase: "completed", progress: 1, finishedAt: new Date().toISOString(), result: { ...evidence, stability, scorecard, manifest: { id: manifest.contentHash, version: manifest.version, promptMode: manifest.promptMode, pairs: processedPairs,plannedPairs:plannedItems.length, requestsUsed: requestCount, maxRequests, pairOrder:"seeded-random",pairConcurrency:1,startGapP95Ms:startGaps.length?startGaps[Math.max(0,Math.ceil(startGaps.length*.95)-1)]:null }, observations: { responseModels, completed, failed,targetCompleted,targetFailed } } });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.repo.updateV2Run(id, { status: "failed", phase: "failed", finishedAt: new Date().toISOString(), error: redact(error instanceof Error ? error.message : String(error)) });
    } finally { this.credentialSessions?.deleteRun(id); }
  }

  private async observe(input: { endpoint: { baseUrl: string; apiKey: string; protocol: AdapterId; model: string; headers?: Record<string, string> }; item: { system: string; user: string; cellId: string }; signal: AbortSignal }): Promise<V2SampleValue> {
    try {
      const response = await adapterFor(input.endpoint.protocol).complete({ baseUrl: input.endpoint.baseUrl, apiKey: input.endpoint.apiKey, model: input.endpoint.model, system: input.item.system, user: input.item.user, temperature: 1, maxTokens: 16, disableReasoning: true, allowCompatibilityRetry: false, headers: input.endpoint.headers, signal: input.signal, timeoutMs: 60_000 });
      const cell = PAMELA_BATTERY.find((candidate) => candidate.id === input.item.cellId)!;
      const normalized = normalizePamelaAnswer(cell, response.text);
      return { validity: normalized.validity, category: normalized.category, latencyMs: response.latencyMs, responseModel: response.responseModel, reasoningDisabled: response.reasoningDisabled, usage: response.usage };
    } catch (error) {
      return { validity: "error", error: redact(error instanceof Error ? error.message : String(error)) };
    }
  }
}

function push(map: Map<string, V2SampleValue[]>, key: string, value: V2SampleValue): void { map.set(key, [...(map.get(key) ?? []), value]); }
function mapDistribution(map: Map<string, V2SampleValue[]>): Record<string, CellDistribution> {
  const out: Record<string, CellDistribution> = {};
  for (const [cellId, values] of map) out[cellId] = empiricalDistribution(values.map((value) => value.validity === "error" ? { validity: "error" as const } : { raw: value.category ?? "", token: value.category ?? "", category: value.category, validity: value.validity as any }));
  return out;
}
function adapterProtocol(value: unknown, fallback: AdapterId): AdapterId {
  return value === "openai-compatible" || value === "openai-responses" || value === "anthropic-messages" ? value : fallback;
}
function seededOrder(seed:string):boolean { let value=2166136261;for(const character of seed)value=Math.imul(value^character.charCodeAt(0),16777619);return(value>>>0)%2===0; }
function redact(message: string): string { return message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._-]{8,}\b/gi, "[redacted]").slice(0, 1000); }

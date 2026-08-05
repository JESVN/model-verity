import { adapterFor } from "../core/adapters/registry.js";
import { BATTERY, BATTERY_VERSION, ONE_WORD_SYSTEM, SYSTEM_PROMPT_VERSION } from "../core/battery/index.js";
import {
  PAMELA_BATTERY,
  PAMELA_BATTERY_VERSION,
  PAMELA_NORMALIZE_VERSION,
  PAMELA_SYSTEM_PROMPT_VERSION,
  pamelaSystemPrompt,
} from "../core/battery/pamela.js";
import { NORMALIZE_VERSION, normalizeAnswer, type NormalizedAnswer } from "../core/normalize/index.js";
import { normalizePamelaAnswer } from "../core/normalize/pamela.js";
import { executePlan } from "../core/run/executor.js";
import { createRunPlan, PROFILE_BUDGETS, selectCells, type RunProfile } from "../core/run/planner.js";
import { compareFingerprints, empiricalDistribution, minValidForRepetitions, type CellDistribution } from "../core/stats/index.js";
import { classifyVerdictDetailed, verdictHeadline } from "../core/stats/verdict.js";
import { Repository, type ReferenceRecord, type RunRecord } from "./db.js";
import { SecretStore } from "./secrets.js";
import { getBuiltinReference, type BuiltinReference } from "./builtin-library.js";

interface SampleValue { answer: NormalizedAnswer; latencyMs: number; responseModel?: string; raw?: unknown; reasoningDisabled: boolean }

export class RunManager {
  private controllers = new Map<string, AbortController>();
  constructor(private repo: Repository, private secrets: SecretStore) {}

  launch(id: string): void {
    if (this.controllers.has(id)) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.execute(id, controller).finally(() => this.controllers.delete(id));
  }

  async cancel(id: string): Promise<RunRecord> {
    const run = this.repo.getRun(id);
    if (!run) throw new Error("run not found");
    if (!["queued", "running"].includes(run.status)) return run;
    this.repo.updateRun(id, { abortRequested: true });
    this.controllers.get(id)?.abort();
    return this.repo.updateRun(id, { status: "cancelled", finishedAt: new Date().toISOString(), error: "cancelled by user" });
  }

  async shutdown(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    while (this.controllers.size) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private async execute(id: string, controller: AbortController): Promise<void> {
    const run = this.repo.getRun(id);
    if (!run) return;
    try {
      this.repo.updateRun(id, { status: "running", startedAt: new Date().toISOString(), progress: 0 });
      const provider = this.repo.getProvider(run.providerId);
      if (!provider) throw new Error("provider not found");
      const apiKey = await this.secrets.get(provider.secretRef);
      if (!apiKey) throw new Error("provider API key unavailable");
      const settings = this.repo.settings();
      const adapter = adapterFor(provider.protocol);
      let reference: ReferenceRecord | BuiltinReference | undefined;
      let profile = run.profile as RunProfile;
      let cellIds: string[] | undefined;
      let protocol: "local" | "pamela" = "local";
      if (run.kind === "audit") {
        reference = run.referenceId
          ? this.repo.getReference(run.referenceId) ?? getBuiltinReference(run.referenceId)
          : undefined;
        if (!reference) throw new Error("reference fingerprint not found");
        if (
          reference.batteryVersion === PAMELA_BATTERY_VERSION
          && reference.normalizeVersion === PAMELA_NORMALIZE_VERSION
          && reference.systemPromptVersion === PAMELA_SYSTEM_PROMPT_VERSION
        ) protocol = "pamela";
        else if (
          reference.batteryVersion !== BATTERY_VERSION
          || reference.normalizeVersion !== NORMALIZE_VERSION
          || reference.systemPromptVersion !== SYSTEM_PROMPT_VERSION
        ) throw new Error("reference protocol version mismatch");
        const desired = PROFILE_BUDGETS[profile]?.cells ?? 8;
        if (reference.cellIds.length < desired) throw new Error(`reference covers ${reference.cellIds.length} cells; ${desired} required`);
      } else if (profile !== "full") {
        profile = "enroll";
      }
      const battery = protocol === "pamela" ? PAMELA_BATTERY : BATTERY;
      if (run.kind === "audit") {
        const desired = PROFILE_BUDGETS[profile]?.cells ?? 8;
        const referenceCells = reference!.fingerprint as { cells: Record<string, CellDistribution> };
        const available = battery.filter((cell) => {
          if (!reference!.cellIds.includes(cell.id)) return false;
          const refCell = referenceCells.cells[cell.id];
          return refCell && refCell.nValid >= 10;
        });
        if (available.length < desired) throw new Error(`reference has only ${available.length} cells with sufficient valid samples (nValid>=10); ${desired} required`);
        cellIds = selectCells(desired, id, available).map((cell) => cell.id);
      }
      const plan = createRunPlan(profile, id, { ...(cellIds ? { cellIds } : {}), battery });
      const completedByCell = new Map<string, (SampleValue | { validity: "error" })[]>();
      const latencies: number[] = [];
      const responseModels = new Map<string, number>();
      const retainRaw = settings.retainRaw;
      let progressSuccess = 0;
      let progressFailed = 0;
      const execution = await executePlan(plan.samples, async (sample, signal) => {
        const response = await adapter.complete({
          baseUrl: provider.baseUrl,
          apiKey,
          model: run.model,
          system: protocol === "pamela" ? pamelaSystemPrompt(sample.cell.language) : ONE_WORD_SYSTEM,
          user: sample.cell.prompt,
          temperature: 1,
          maxTokens: 16,
          disableReasoning: true,
          headers: provider.headers,
          signal,
          timeoutMs: 60_000,
        });
        const answer = protocol === "pamela"
          ? normalizePamelaAnswer(sample.cell, response.text)
          : normalizeAnswer(sample.cell, response.text);
        return { answer, latencyMs: response.latencyMs, responseModel: response.responseModel, raw: retainRaw ? response.raw : undefined, reasoningDisabled: response.reasoningDisabled } satisfies SampleValue;
      }, {
        concurrency: settings.concurrency,
        signal: controller.signal,
        circuitBreakAfter: Math.max(8, settings.concurrency * 3),
        onProgress: ({ completed, total, item, result, error }) => {
          const values = completedByCell.get(item.cell.id) ?? [];
          if (result) {
            values.push(result);
            latencies.push(result.latencyMs);
            if (result.responseModel) responseModels.set(result.responseModel, (responseModels.get(result.responseModel) ?? 0) + 1);
          }
          // Errors are added after execution from the complete errors map, including circuit-skipped samples.
          completedByCell.set(item.cell.id, values);
          if (result) progressSuccess += 1;
          else progressFailed += 1;
          this.repo.updateRun(id, { progress: completed / total, successCount: progressSuccess, failCount: progressFailed });
        },
      });
      if (controller.signal.aborted) return;
      for (const [sampleId] of execution.errors) {
        const cellId = sampleId.split(":").slice(0, 2).join(":");
        const values = completedByCell.get(cellId) ?? [];
        values.push({ validity: "error" });
        completedByCell.set(cellId, values);
      }
      const cells: Record<string, CellDistribution> = {};
      for (const cell of plan.cells) {
        const values = completedByCell.get(cell.id) ?? [];
        cells[cell.id] = empiricalDistribution(values.map((entry) => "answer" in entry ? entry.answer : entry));
      }
      const total = plan.samples.length;
      const succeeded = execution.results.size;
      const successRate = total ? succeeded / total : 0;
      const counts = Object.values(cells).reduce((sum, cell) => ({
        valid: sum.valid + cell.nValid,
        invalid: sum.invalid + cell.nInvalid,
        refusal: sum.refusal + cell.nRefusal,
        empty: sum.empty + cell.nEmpty,
        error: sum.error + cell.nError,
      }), { valid: 0, invalid: 0, refusal: 0, empty: 0, error: 0 });
      const invalidCount = counts.invalid + counts.refusal + counts.empty;
      const p50ms = percentile(latencies, 0.5);
      const p95ms = percentile(latencies, 0.95);
      const errorClasses = classifyErrors(execution.errors.values());
      this.repo.updateRun(id, { successCount: succeeded, failCount: execution.errors.size });
      const responseModelCounts = Object.fromEntries([...responseModels.entries()].sort((a, b) => b[1] - a[1]));
      const weakModel = Object.keys(responseModelCounts)[0];
      const protocolDegraded = [...completedByCell.values()].flat().some((value) => "reasoningDisabled" in value && !value.reasoningDisabled);
      if (run.kind === "enroll") {
        const comparableCells = Object.values(cells).filter((cell) => cell.nValid >= 10).length;
        if (successRate < 0.7 || comparableCells < Math.max(2, Math.ceil(plan.cells.length / 2))) {
          this.repo.updateRun(id, { status: "failed", finishedAt: new Date().toISOString(), progress: 1, error: "insufficient valid samples for a trustworthy reference", result: { successRate, p50ms, p95ms, errorClasses, invalidRate: succeeded ? invalidCount / succeeded : 0, cellsUsed: `${comparableCells}/${plan.cells.length}` } });
          return;
        }
        const ref = this.repo.saveReference({ 
          providerId: provider.id,
          modelClaimed: run.model,
          label: `${provider.name} · ${run.model}`,
          baseUrl: provider.baseUrl,
          enrolledAt: new Date().toISOString(),
          batteryVersion: BATTERY_VERSION,
          normalizeVersion: NORMALIZE_VERSION,
          systemPromptVersion: SYSTEM_PROMPT_VERSION,
          cellIds: plan.cells.map((cell) => cell.id),
          fingerprint: {
            params: { temperature: 1, maxTokens: 16 },
            protocolDegraded,
            cells,
            ...(retainRaw ? { rawSamples: Object.fromEntries([...completedByCell].map(([cellId, values]) => [cellId, values.filter((value): value is SampleValue => "answer" in value).map((value) => value.raw)])) } : {}),
          },
        });
        this.repo.updateRun(id, { status: "completed", finishedAt: new Date().toISOString(), progress: 1, result: { referenceId: ref.id, successRate, p50ms, p95ms, errorClasses, invalidRate: succeeded ? invalidCount / succeeded : 0, counts: { planned: total, succeeded, failed: execution.errors.size, ...counts }, cellsUsed: `${Object.keys(cells).length}/40`, responseModelWeakSignal: weakModel, responseModelCounts, protocolDegraded } });
        return;
      }
      const fingerprint = reference!.fingerprint as { cells: Record<string, CellDistribution>; protocolDegraded?: boolean };
      const reps = PROFILE_BUDGETS[profile]?.repetitions ?? 15;
      const auditMinValid = minValidForRepetitions(reps);
      const distance = compareFingerprints(fingerprint, { cells }, plan.cells.map((cell) => cell.id), auditMinValid);
      const comparisonDegraded = protocolDegraded || Boolean(fingerprint.protocolDegraded);
      const decision = classifyVerdictDetailed({ score: distance.score, successRate, comparableCells: distance.cells.length, plannedCells: plan.cells.length, tauMatch: settings.tauMatch, tauMid: settings.tauMid, protocolDegraded: comparisonDegraded });
      const verdict = decision.verdict;
      const builtinReference = "sourceType" in reference! && reference!.sourceType === "builtin-research"
        ? reference as BuiltinReference
        : undefined;
      const builtin = Boolean(builtinReference);
      const protocolNotes = [
        comparisonDegraded ? "reasoning 关闭未确认，协议降级" : "reasoning 已关闭",
        distance.excluded.length ? `${distance.excluded.length} cells excluded` : undefined,
        builtin ? "与 OpenRouter 研究快照相对比较；不是厂商认证" : undefined,
      ].filter(Boolean);
      const protocolNote = protocolNotes.join("；");
      const finishedAt = new Date().toISOString();
      const endpoint = safeEndpoint(provider.baseUrl);
      this.repo.updateRun(id, { status: verdict === "failed" ? "failed" : "completed", finishedAt, progress: 1, result: {
        trust: verdict, verdictHeadline: verdictHeadline(decision, run.error), score: distance.score,
        scoreWouldMatch: decision.scoreWouldMatch, verdictReason: decision.reason,
        thresholds: { match: decision.tauMatch, mid: decision.tauMid },
        decision: { reason: decision.reason, minSuccessRate: decision.minSuccessRate, minCellsOk: decision.minCellsOk, comparableCells: distance.cells.length, plannedCells: plan.cells.length, protocolDegraded: comparisonDegraded },
        reference: { label: reference!.label, enrolledAt: reference!.enrolledAt, sourceType: builtin ? "builtin-research" : "local-enrollment", batteryVersion: reference!.batteryVersion, normalizeVersion: reference!.normalizeVersion, systemPromptVersion: reference!.systemPromptVersion, ...(builtinReference ? { datasetDoi: builtinReference.datasetDoi, license: builtinReference.license, trustNotice: builtinReference.trustNotice } : {}) },
        run: { providerName: provider.name, endpoint, requestedModel: run.model, claimedModel: run.claimedModel ?? run.model, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt, plannedRequests: total, completedRequests: succeeded + execution.errors.size },
        reliability: { successRate, p50ms, p95ms, errorClasses, invalidRate: succeeded ? invalidCount / succeeded : 0, counts: { planned: total, succeeded, failed: execution.errors.size, ...counts } },
        profile: run.profile, cellsUsed: `${distance.cells.length}/${plan.cells.length}`,
        responseModelWeakSignal: weakModel, responseModelCounts, protocolNote,
        cells: distance.cells, excludedCells: distance.excluded, minValidPerCell: auditMinValid,
        ...(retainRaw ? { rawSamples: Object.fromEntries([...completedByCell].map(([cellId, values]) => [cellId, values.filter((value): value is SampleValue => "answer" in value).map((value) => value.raw)])) } : {}),
      } });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.repo.updateRun(id, { status: "failed", finishedAt: new Date().toISOString(), error: redactError(error instanceof Error ? error.message : String(error)) });
    }
  }
}

function redactError(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._-]{8,}\b/gi, "[redacted]")
    .slice(0, 1000);
}

function classifyErrors(errors: Iterable<Error>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const error of errors) {
    const status = (error as Error & { status?: number }).status;
    const category = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : status != null && status >= 500 ? "server" : error.name === "TimeoutError" || status === 408 || /timed out/i.test(error.message) ? "timeout" : /circuit breaker/i.test(error.message) ? "circuit" : "other";
    result[category] = (result[category] ?? 0) + 1;
  }
  return result;
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return "endpoint unavailable"; }
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]);
}

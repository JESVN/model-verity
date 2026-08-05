import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirectory } from "./runtime.js";
import type { AdapterId } from "../core/adapters/types.js";

export type ProviderRole = "reference" | "audit" | "either";
export interface ProviderRecord { id: string; name: string; protocol: AdapterId; baseUrl: string; models: string[]; role: ProviderRole; secretRef: string; headers: Record<string, string>; createdAt: string; updatedAt: string; deletedAt?: string }
export interface ReferenceRecord { id: string; providerId: string; modelClaimed: string; label: string; baseUrl: string; enrolledAt: string; batteryVersion: string; normalizeVersion: string; systemPromptVersion: string; cellIds: string[]; fingerprint: unknown }
export interface RunRecord { id: string; kind: "enroll" | "audit"; status: string; providerId: string; model: string; claimedModel?: string; referenceId?: string; profile: string; createdAt: string; startedAt?: string; finishedAt?: string; progress: number; successCount: number; failCount: number; result?: any; error?: string; abortRequested: boolean }
export interface SettingsRecord { concurrency: number; tauMatch: number; tauMid: number; retainRaw: boolean }
export interface V2RunRecord { id: string; mode: "screening" | "paired" | "reference_enrollment"; status: string; phase: string; providerId: string; referenceProviderId?: string; referenceId?: string; model: string; referenceModel?: string; profile: string; protocolComparability: string; referenceLevel: string; identity: any; budget: any; progress: number; successCount: number; failCount: number; createdAt: string; startedAt?: string; finishedAt?: string; result?: any; error?: string; abortRequested: boolean }
export interface CalibrationRecord { id: string; version: string; vendor: string; product: string; surface: string; profile: string; artifact: any; active: boolean; createdAt: string }
export interface BudgetAuthorizationRecord { id:string; limits:any; allowed:any; usedRequests:number; usedInputTokens:number; usedOutputTokens:number; expiresAt:string; revokedAt?:string; createdAt:string }
export interface ReferenceCohortV2Record { id:string;label:string;vendor:string;product:string;surface:string;status:string;createdAt:string;updatedAt:string }
export interface ReferenceVersionV2Record { id:string; cohortId?:string; level:string; identity:any; protocol:string; collectedAt:string; lastConfirmedAt:string; freshnessStatus:string; qualityStatus:string; manifestHash:string; fingerprint:any; createdAt:string }
export interface ReferenceGovernanceEventRecord { id:string;referenceVersionId:string;eventType:string;details:any;createdAt:string }
export interface V2EndpointRecord { id:string;runId:string;role:string;providerId?:string;endpointHash:string;credentialScopeHash:string;protocol:string;model:string;identity:any;configRevision:string;createdAt:string }
export interface ShareReportRecord { id:string; runId:string; reportHash:string; report:any; expiresAt:string; revokedAt?:string; createdAt:string }

function parse<T>(value: string | null, fallback: T): T { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }

export class Repository {
  readonly db: Database.Database;
  constructor(dataDir = dataDirectory()) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dataDir, "db.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }
  close(): void { this.db.close(); }
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL, base_url TEXT NOT NULL,
        models_json TEXT NOT NULL, role TEXT NOT NULL, secret_ref TEXT NOT NULL, headers_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS reference_fingerprints (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_claimed TEXT NOT NULL, label TEXT NOT NULL, base_url TEXT NOT NULL, enrolled_at TEXT NOT NULL,
        battery_version TEXT NOT NULL, normalize_version TEXT NOT NULL, system_prompt_version TEXT NOT NULL,
        cell_ids_json TEXT NOT NULL, fingerprint_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model TEXT NOT NULL, claimed_model TEXT, reference_id TEXT REFERENCES reference_fingerprints(id) ON DELETE SET NULL,
        profile TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        progress REAL NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT, error TEXT, abort_requested INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS model_identities_v2 (
        id TEXT PRIMARY KEY, vendor TEXT NOT NULL, product TEXT NOT NULL, surface TEXT NOT NULL,
        snapshot TEXT, declared_json TEXT NOT NULL, observed_json TEXT, inferred_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_model_mappings_v2 (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), model TEXT NOT NULL,
        identity_id TEXT NOT NULL REFERENCES model_identities_v2(id), config_revision TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider_id, model)
      );
      CREATE TABLE IF NOT EXISTS reference_cohorts_v2 (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, vendor TEXT NOT NULL, product TEXT NOT NULL, surface TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reference_versions_v2 (
        id TEXT PRIMARY KEY, cohort_id TEXT REFERENCES reference_cohorts_v2(id), level TEXT NOT NULL,
        identity_json TEXT NOT NULL, protocol TEXT NOT NULL, collected_at TEXT NOT NULL,
        last_confirmed_at TEXT NOT NULL, freshness_status TEXT NOT NULL, quality_status TEXT NOT NULL,
        manifest_hash TEXT NOT NULL, fingerprint_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reference_governance_events_v2 (
        id TEXT PRIMARY KEY, reference_version_id TEXT NOT NULL REFERENCES reference_versions_v2(id),
        event_type TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calibration_profiles_v2 (
        id TEXT PRIMARY KEY, version TEXT NOT NULL, vendor TEXT NOT NULL, product TEXT NOT NULL, surface TEXT NOT NULL,
        profile TEXT NOT NULL, artifact_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calibration_artifacts_v2 (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES calibration_profiles_v2(id),
        content_hash TEXT NOT NULL UNIQUE, artifact_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_authorizations_v2 (
        id TEXT PRIMARY KEY, limits_json TEXT NOT NULL, allowed_json TEXT NOT NULL, used_requests INTEGER NOT NULL DEFAULT 0,
        used_input_tokens INTEGER NOT NULL DEFAULT 0, used_output_tokens INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verification_runs_v2 (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
        provider_id TEXT NOT NULL REFERENCES providers(id), reference_provider_id TEXT REFERENCES providers(id), reference_id TEXT,
        model TEXT NOT NULL, reference_model TEXT, profile TEXT NOT NULL, protocol_comparability TEXT NOT NULL,
        reference_level TEXT NOT NULL, identity_json TEXT NOT NULL, budget_json TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, result_json TEXT, error TEXT,
        abort_requested INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS verification_run_endpoints_v2 (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES verification_runs_v2(id) ON DELETE CASCADE,
        role TEXT NOT NULL, provider_id TEXT REFERENCES providers(id), endpoint_hash TEXT NOT NULL,
        credential_scope_hash TEXT NOT NULL, protocol TEXT NOT NULL, model TEXT NOT NULL, identity_json TEXT NOT NULL,
        config_revision TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS challenge_manifests_v2 (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES verification_runs_v2(id) ON DELETE CASCADE,
        version TEXT NOT NULL, content_hash TEXT NOT NULL, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS challenge_blocks_v2 (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES verification_runs_v2(id) ON DELETE CASCADE,
        block_index INTEGER NOT NULL, status TEXT NOT NULL, planned_pairs INTEGER NOT NULL,
        completed_pairs INTEGER NOT NULL DEFAULT 0, stop_reason TEXT, created_at TEXT NOT NULL, finished_at TEXT,
        UNIQUE(run_id, block_index)
      );
      CREATE TABLE IF NOT EXISTS challenge_observations_v2 (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES verification_runs_v2(id) ON DELETE CASCADE,
        block_id TEXT NOT NULL REFERENCES challenge_blocks_v2(id) ON DELETE CASCADE, pair_id TEXT NOT NULL,
        challenge_id TEXT NOT NULL, endpoint_role TEXT NOT NULL, cell_id TEXT NOT NULL, repetition INTEGER NOT NULL,
        request_hash TEXT NOT NULL, validity TEXT, normalized_category TEXT, reported_model TEXT,
        latency_ms REAL, usage_json TEXT, protocol_degraded INTEGER NOT NULL DEFAULT 0,
        pair_completeness TEXT NOT NULL, time_gap_ms REAL, created_at TEXT NOT NULL,
        UNIQUE(run_id, challenge_id, endpoint_role)
      );
      CREATE TABLE IF NOT EXISTS observation_attempts_v2 (
        id TEXT PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES challenge_observations_v2(id) ON DELETE CASCADE,
        attempt_index INTEGER NOT NULL, status TEXT NOT NULL, http_status INTEGER, error_category TEXT,
        latency_ms REAL, reported_model TEXT, usage_json TEXT, visible_answer TEXT, raw_hash TEXT,
        started_at TEXT NOT NULL, finished_at TEXT NOT NULL, UNIQUE(observation_id, attempt_index)
      );
      CREATE TABLE IF NOT EXISTS verification_evidence_v2 (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES verification_runs_v2(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, framework_version TEXT NOT NULL, calibration_id TEXT,
        evidence_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, revision)
      );
      CREATE TABLE IF NOT EXISTS verification_conclusions_v2 (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES verification_runs_v2(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, conclusion_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, revision)
      );
      CREATE TABLE IF NOT EXISTS verification_series_v2 (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, schedule_enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS share_reports_v2 (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES verification_runs_v2(id) ON DELETE CASCADE,
        report_hash TEXT NOT NULL, report_json TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS legacy_runs_read_only_v2 BEFORE UPDATE ON runs
        WHEN (SELECT value_json FROM settings WHERE key='legacyReadOnly')='true'
        BEGIN SELECT RAISE(ABORT, 'legacy runs are read-only'); END;
      CREATE TRIGGER IF NOT EXISTS legacy_references_read_only_v2 BEFORE UPDATE ON reference_fingerprints
        WHEN (SELECT value_json FROM settings WHERE key='legacyReadOnly')='true'
        BEGIN SELECT RAISE(ABORT, 'legacy references are read-only'); END;
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now')); 
    `);
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "claimed_model")) this.db.exec("ALTER TABLE runs ADD COLUMN claimed_model TEXT");
    if (!columns.some((column) => column.name === "success_count")) this.db.exec("ALTER TABLE runs ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0");
    if (!columns.some((column) => column.name === "fail_count")) this.db.exec("ALTER TABLE runs ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0");
    if (!columns.some((column) => column.name === "reference_external_id")) this.db.exec("ALTER TABLE runs ADD COLUMN reference_external_id TEXT");
    const providerColumns = this.db.prepare("PRAGMA table_info(providers)").all() as { name: string }[];
    if (!providerColumns.some((column) => column.name === "deleted_at")) this.db.exec("ALTER TABLE providers ADD COLUMN deleted_at TEXT");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'))").run();
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'))").run();
    const v2RunColumns = this.db.prepare("PRAGMA table_info(verification_runs_v2)").all() as { name: string }[];
    if (!v2RunColumns.some((column) => column.name === "reference_id")) this.db.exec("ALTER TABLE verification_runs_v2 ADD COLUMN reference_id TEXT");
    const budgetColumns = this.db.prepare("PRAGMA table_info(budget_authorizations_v2)").all() as { name:string }[];
    if (!budgetColumns.some((column)=>column.name==="used_input_tokens")) this.db.exec("ALTER TABLE budget_authorizations_v2 ADD COLUMN used_input_tokens INTEGER NOT NULL DEFAULT 0");
    if (!budgetColumns.some((column)=>column.name==="used_output_tokens")) this.db.exec("ALTER TABLE budget_authorizations_v2 ADD COLUMN used_output_tokens INTEGER NOT NULL DEFAULT 0");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'))").run();
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, datetime('now'))").run();
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, datetime('now'))").run();
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, datetime('now'))").run();
  }
  listProviders(): ProviderRecord[] { return this.db.prepare("SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY created_at DESC").all().map(mapProvider); }
  getProvider(id: string): ProviderRecord | undefined { const row = this.db.prepare("SELECT * FROM providers WHERE id=? AND deleted_at IS NULL").get(id); return row ? mapProvider(row) : undefined; }
  saveProvider(input: Omit<ProviderRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): ProviderRecord {
    const old = input.id ? this.getProvider(input.id) : undefined; const now = new Date().toISOString(); const id = input.id ?? randomUUID();
    this.db.prepare(`INSERT INTO providers(id,name,protocol,base_url,models_json,role,secret_ref,headers_json,created_at,updated_at)
      VALUES(@id,@name,@protocol,@baseUrl,@models,@role,@secretRef,@headers,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,protocol=excluded.protocol,base_url=excluded.base_url,models_json=excluded.models_json,role=excluded.role,secret_ref=excluded.secret_ref,headers_json=excluded.headers_json,updated_at=excluded.updated_at`).run({ ...input, id, models: JSON.stringify(input.models), headers: JSON.stringify(input.headers), createdAt: old?.createdAt ?? now, updatedAt: now });
    return this.getProvider(id)!;
  }
  deleteProvider(id: string): ProviderRecord | undefined { const row = this.db.prepare("SELECT * FROM providers WHERE id=? AND deleted_at IS NULL").get(id); const old = row ? mapProvider(row) : undefined; if (old) this.db.prepare("UPDATE providers SET deleted_at=?, secret_ref='' WHERE id=?").run(new Date().toISOString(), id); return old; }
  providerUsage(id: string): { references: number; activeRuns: number; historyRuns: number } {
    const legacyReferences = (this.db.prepare("SELECT COUNT(*) AS count FROM reference_fingerprints WHERE provider_id=?").get(id) as any).count as number;
    const legacyActive = (this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE provider_id=? AND status IN ('queued','running')").get(id) as any).count as number;
    const v2Active = (this.db.prepare("SELECT COUNT(*) AS count FROM verification_runs_v2 WHERE provider_id=? AND status IN ('queued','running')").get(id) as any).count as number;
    const legacyHistory = (this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE provider_id=?").get(id) as any).count as number;
    const v2History = (this.db.prepare("SELECT COUNT(*) AS count FROM verification_runs_v2 WHERE provider_id=?").get(id) as any).count as number;
    return { references: legacyReferences, activeRuns: legacyActive + v2Active, historyRuns: legacyHistory + v2History };
  }
  listReferences(): ReferenceRecord[] { return this.db.prepare("SELECT * FROM reference_fingerprints ORDER BY enrolled_at DESC").all().map(mapReference); }
  getReference(id: string): ReferenceRecord | undefined { const row=this.db.prepare("SELECT * FROM reference_fingerprints WHERE id=?").get(id); return row ? mapReference(row) : undefined; }
  saveReference(input: Omit<ReferenceRecord, "id"> & { id?: string }): ReferenceRecord { const id=input.id??randomUUID(); this.db.prepare(`INSERT OR REPLACE INTO reference_fingerprints(id,provider_id,model_claimed,label,base_url,enrolled_at,battery_version,normalize_version,system_prompt_version,cell_ids_json,fingerprint_json) VALUES(@id,@providerId,@modelClaimed,@label,@baseUrl,@enrolledAt,@batteryVersion,@normalizeVersion,@systemPromptVersion,@cellIds,@fingerprint)`).run({...input,id,cellIds:JSON.stringify(input.cellIds),fingerprint:JSON.stringify(input.fingerprint)}); return this.getReference(id)!; }
  deleteReference(id:string):void { this.db.prepare("DELETE FROM reference_fingerprints WHERE id=?").run(id); }
  referenceUsage(id: string): { activeRuns: number; historyRuns: number } {
    const activeRuns = (this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE reference_id=? AND status IN ('queued','running')").get(id) as any).count as number;
    const historyRuns = (this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE reference_id=?").get(id) as any).count as number;
    return { activeRuns, historyRuns };
  }
  activeRunCount(): number { return (this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued','running')").get() as any).count as number; }
  createRun(input: Pick<RunRecord,"kind"|"providerId"|"model"|"profile"> & {referenceId?:string; claimedModel?: string}):RunRecord { const id=randomUUID(), createdAt=new Date().toISOString(); const external=Boolean(input.referenceId?.startsWith("builtin:")); this.db.prepare("INSERT INTO runs(id,kind,status,provider_id,model,claimed_model,reference_id,reference_external_id,profile,created_at,progress) VALUES(?,?, 'queued',?,?,?,?,?,?,?,0)").run(id,input.kind,input.providerId,input.model,input.claimedModel??null,external?null:input.referenceId??null,external?input.referenceId:null,input.profile,createdAt); return this.getRun(id)!; }
  getRun(id:string):RunRecord|undefined { const row=this.db.prepare("SELECT * FROM runs WHERE id=?").get(id); return row?mapRun(row):undefined; }
  listRuns():RunRecord[] { return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all().map(mapRun); }
  deleteRun(id: string): { deleted: boolean; reason?: string } {
    const run = this.getRun(id);
    if (!run) return { deleted: false, reason: "not_found" };
    if (run.status === "queued" || run.status === "running") return { deleted: false, reason: "active" };
    this.db.prepare("DELETE FROM runs WHERE id=?").run(id);
    return { deleted: true };
  }
  deleteRuns(ids: readonly string[]): { deleted: string[]; skipped: { id: string; reason: string }[] } {
    const unique = [...new Set(ids.filter(Boolean))];
    const deleted: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const remove = this.db.prepare("DELETE FROM runs WHERE id=?");
    const tx = this.db.transaction((values: string[]) => {
      for (const id of values) {
        const run = this.getRun(id);
        if (!run) { skipped.push({ id, reason: "not_found" }); continue; }
        if (run.status === "queued" || run.status === "running") { skipped.push({ id, reason: "active" }); continue; }
        remove.run(id);
        deleted.push(id);
      }
    });
    tx(unique);
    return { deleted, skipped };
  }
  recoverInterruptedRuns(): number {
    const now = new Date().toISOString();
    const legacy=this.db.prepare("UPDATE runs SET status='failed', finished_at=?, error='server restarted before run completed' WHERE status IN ('queued','running')").run(now).changes;
    const v2=this.db.prepare("UPDATE verification_runs_v2 SET status='failed', phase='failed', finished_at=?, error='server restarted before run completed; temporary credentials must be re-authorized' WHERE status IN ('queued','running')").run(now).changes;
    return legacy+v2;
  }
  updateRun(id:string, patch:Partial<Pick<RunRecord,"status"|"startedAt"|"finishedAt"|"progress"|"successCount"|"failCount"|"result"|"error"|"abortRequested">>):RunRecord { const current=this.getRun(id); if(!current) throw new Error("run not found"); const next={...current,...patch}; this.db.prepare("UPDATE runs SET status=?,started_at=?,finished_at=?,progress=?,success_count=?,fail_count=?,result_json=?,error=?,abort_requested=? WHERE id=?").run(next.status,next.startedAt??null,next.finishedAt??null,next.progress,next.successCount,next.failCount,next.result==null?null:JSON.stringify(next.result),next.error??null,next.abortRequested?1:0,id); return this.getRun(id)!; }
  createV2Run(input: Pick<V2RunRecord,"mode"|"providerId"|"model"|"profile"|"protocolComparability"|"referenceLevel"|"identity"|"budget"> & {referenceProviderId?:string;referenceId?:string;referenceModel?:string}):V2RunRecord { const id=randomUUID(),createdAt=new Date().toISOString(); this.db.prepare(`INSERT INTO verification_runs_v2(id,mode,status,phase,provider_id,reference_provider_id,reference_id,model,reference_model,profile,protocol_comparability,reference_level,identity_json,budget_json,created_at) VALUES(?,?, 'queued','planning',?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.mode,input.providerId,input.referenceProviderId??null,input.referenceId??null,input.model,input.referenceModel??null,input.profile,input.protocolComparability,input.referenceLevel,JSON.stringify(input.identity),JSON.stringify(input.budget),createdAt); return this.getV2Run(id)!; }
  getV2Run(id:string):V2RunRecord|undefined { const row=this.db.prepare("SELECT * FROM verification_runs_v2 WHERE id=?").get(id); return row?mapV2Run(row):undefined; }
  listV2Runs():V2RunRecord[] { return this.db.prepare("SELECT * FROM verification_runs_v2 ORDER BY created_at DESC").all().map(mapV2Run); }
  activeV2RunCount():number { return (this.db.prepare("SELECT COUNT(*) AS count FROM verification_runs_v2 WHERE status IN ('queued','running')").get() as any).count as number; }
  updateV2Run(id:string,patch:Partial<Pick<V2RunRecord,"status"|"phase"|"progress"|"successCount"|"failCount"|"startedAt"|"finishedAt"|"result"|"error"|"abortRequested">>):V2RunRecord { const current=this.getV2Run(id);if(!current)throw new Error("v2 run not found");const next={...current,...patch};this.db.prepare("UPDATE verification_runs_v2 SET status=?,phase=?,progress=?,success_count=?,fail_count=?,started_at=?,finished_at=?,result_json=?,error=?,abort_requested=? WHERE id=?").run(next.status,next.phase,next.progress,next.successCount,next.failCount,next.startedAt??null,next.finishedAt??null,next.result==null?null:JSON.stringify(next.result),next.error??null,next.abortRequested?1:0,id);return this.getV2Run(id)!; }
  saveV2Endpoint(input:Omit<V2EndpointRecord,"id"|"createdAt">):V2EndpointRecord { const id=randomUUID(),createdAt=new Date().toISOString();this.db.prepare(`INSERT INTO verification_run_endpoints_v2(id,run_id,role,provider_id,endpoint_hash,credential_scope_hash,protocol,model,identity_json,config_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.runId,input.role,input.providerId??null,input.endpointHash,input.credentialScopeHash,input.protocol,input.model,JSON.stringify(input.identity),input.configRevision,createdAt);return{id,...input,createdAt}; }
  v2Endpoints(runId:string):V2EndpointRecord[] { return this.db.prepare("SELECT * FROM verification_run_endpoints_v2 WHERE run_id=? ORDER BY role").all(runId).map((row:any)=>({id:row.id,runId:row.run_id,role:row.role,providerId:row.provider_id??undefined,endpointHash:row.endpoint_hash,credentialScopeHash:row.credential_scope_hash,protocol:row.protocol,model:row.model,identity:parse(row.identity_json,{}),configRevision:row.config_revision,createdAt:row.created_at})); }
  saveV2Manifest(runId:string,manifest:any):string { const id=randomUUID();this.db.prepare("INSERT INTO challenge_manifests_v2(id,run_id,version,content_hash,manifest_json,created_at) VALUES(?,?,?,?,?,?)").run(id,runId,manifest.version,manifest.contentHash,JSON.stringify(manifest),new Date().toISOString());return id; }
  saveV2Block(runId:string,index:number,plannedPairs:number):string { const id=randomUUID();this.db.prepare("INSERT INTO challenge_blocks_v2(id,run_id,block_index,status,planned_pairs,created_at) VALUES(?,?,?,'running',?,?)").run(id,runId,index,plannedPairs,new Date().toISOString());return id; }
  finishV2Block(id:string,completedPairs:number,stopReason?:string):void { this.db.prepare("UPDATE challenge_blocks_v2 SET status='completed',completed_pairs=?,stop_reason=?,finished_at=? WHERE id=?").run(completedPairs,stopReason??null,new Date().toISOString(),id); }
  saveV2Observation(input:any):string { const id=randomUUID();this.db.prepare(`INSERT INTO challenge_observations_v2(id,run_id,block_id,pair_id,challenge_id,endpoint_role,cell_id,repetition,request_hash,validity,normalized_category,reported_model,latency_ms,usage_json,protocol_degraded,pair_completeness,time_gap_ms,created_at) VALUES(@id,@runId,@blockId,@pairId,@challengeId,@endpointRole,@cellId,@repetition,@requestHash,@validity,@normalizedCategory,@reportedModel,@latencyMs,@usage,@protocolDegraded,@pairCompleteness,@timeGapMs,@createdAt)`).run({...input,id,usage:JSON.stringify(input.usage??{}),protocolDegraded:input.protocolDegraded?1:0,createdAt:new Date().toISOString()});return id; }
  saveV2Attempt(observationId:string,input:any):string { const id=randomUUID();this.db.prepare(`INSERT INTO observation_attempts_v2(id,observation_id,attempt_index,status,http_status,error_category,latency_ms,reported_model,usage_json,visible_answer,raw_hash,started_at,finished_at) VALUES(@id,@observationId,@attemptIndex,@status,@httpStatus,@errorCategory,@latencyMs,@reportedModel,@usage,@visibleAnswer,@rawHash,@startedAt,@finishedAt)`).run({...input,id,observationId,usage:JSON.stringify(input.usage??{})});return id; }
  v2Observations(runId:string):any[] { return this.db.prepare("SELECT * FROM challenge_observations_v2 WHERE run_id=? ORDER BY created_at").all(runId).map((row:any)=>({...row,usage:parse(row.usage_json,{})})); }
  latestV2Evidence(runId:string):{evidence:any;conclusion:any;revision:number}|undefined { const row=this.db.prepare(`SELECT e.revision,e.evidence_json,c.conclusion_json FROM verification_evidence_v2 e JOIN verification_conclusions_v2 c ON c.run_id=e.run_id AND c.revision=e.revision WHERE e.run_id=? ORDER BY e.revision DESC LIMIT 1`).get(runId) as any;return row?{revision:row.revision,evidence:parse(row.evidence_json,{}),conclusion:parse(row.conclusion_json,{})}:undefined; }
  saveV2Evidence(runId:string,evidence:any,conclusion:any,calibrationId?:string):void { const revision=((this.db.prepare("SELECT MAX(revision) AS revision FROM verification_evidence_v2 WHERE run_id=?").get(runId) as any)?.revision??0)+1;const now=new Date().toISOString();const tx=this.db.transaction(()=>{this.db.prepare("INSERT INTO verification_evidence_v2(id,run_id,revision,framework_version,calibration_id,evidence_json,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(),runId,revision,evidence.conclusion?.frameworkVersion??'service-claims@2.0.0',calibrationId??null,JSON.stringify(evidence),now);this.db.prepare("INSERT INTO verification_conclusions_v2(id,run_id,revision,conclusion_json,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),runId,revision,JSON.stringify(conclusion),now);});tx(); }
  saveCalibration(input:CalibrationRecord):CalibrationRecord { if(input.active)this.db.prepare("UPDATE calibration_profiles_v2 SET active=0 WHERE vendor=? AND product=? AND surface=? AND profile=?").run(input.vendor,input.product,input.surface,input.profile);this.db.prepare("INSERT OR REPLACE INTO calibration_profiles_v2(id,version,vendor,product,surface,profile,artifact_json,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(input.id,input.version,input.vendor,input.product,input.surface,input.profile,JSON.stringify(input.artifact),input.active?1:0,input.createdAt);return input; }
  listCalibrations():CalibrationRecord[] { return this.db.prepare("SELECT * FROM calibration_profiles_v2 ORDER BY created_at DESC").all().map((row:any)=>({id:row.id,version:row.version,vendor:row.vendor,product:row.product,surface:row.surface,profile:row.profile,artifact:parse(row.artifact_json,{}),active:Boolean(row.active),createdAt:row.created_at})); }
  findCalibration(vendor:string,product:string,surface:string,profile:string):CalibrationRecord|undefined { return this.listCalibrations().find((item)=>item.active&&item.vendor===vendor&&item.product===product&&item.surface===surface&&item.profile===profile); }
  createBudgetAuthorization(input:{limits:any;allowed:any;expiresAt:string}):BudgetAuthorizationRecord { const id=randomUUID(),createdAt=new Date().toISOString();this.db.prepare("INSERT INTO budget_authorizations_v2(id,limits_json,allowed_json,expires_at,created_at) VALUES(?,?,?,?,?)").run(id,JSON.stringify(input.limits),JSON.stringify(input.allowed),input.expiresAt,createdAt);return this.getBudgetAuthorization(id)!; }
  getBudgetAuthorization(id:string):BudgetAuthorizationRecord|undefined { const row=this.db.prepare("SELECT * FROM budget_authorizations_v2 WHERE id=?").get(id) as any;return row?{id:row.id,limits:parse(row.limits_json,{}),allowed:parse(row.allowed_json,{}),usedRequests:row.used_requests,usedInputTokens:row.used_input_tokens??0,usedOutputTokens:row.used_output_tokens??0,expiresAt:row.expires_at,revokedAt:row.revoked_at??undefined,createdAt:row.created_at}:undefined; }
  reserveBudgetRequest(id:string,providerId:string,model:string):BudgetAuthorizationRecord { const tx=this.db.transaction(()=>{const auth=this.getBudgetAuthorization(id);if(!auth)throw new Error("budget authorization not found");if(auth.revokedAt)throw new Error("budget authorization revoked");if(Date.parse(auth.expiresAt)<=Date.now())throw new Error("budget authorization expired");if(Array.isArray(auth.allowed.providerIds)&&!auth.allowed.providerIds.includes(providerId))throw new Error("provider not allowed by budget");if(Array.isArray(auth.allowed.models)&&!auth.allowed.models.includes(model))throw new Error("model not allowed by budget");if(auth.usedRequests>=Number(auth.limits.maxEndpointRequests??0))throw new Error("endpoint request budget exhausted");this.db.prepare("UPDATE budget_authorizations_v2 SET used_requests=used_requests+1 WHERE id=?").run(id);return this.getBudgetAuthorization(id)!;});return tx(); }
  accountBudgetTokens(id:string,inputTokens:number,outputTokens:number):BudgetAuthorizationRecord { const tx=this.db.transaction(()=>{const auth=this.getBudgetAuthorization(id);if(!auth)throw new Error("budget authorization not found");const nextInput=auth.usedInputTokens+Math.max(0,inputTokens||0),nextOutput=auth.usedOutputTokens+Math.max(0,outputTokens||0);this.db.prepare("UPDATE budget_authorizations_v2 SET used_input_tokens=?,used_output_tokens=? WHERE id=?").run(nextInput,nextOutput,id);return{record:this.getBudgetAuthorization(id)!,exceeded:nextInput>Number(auth.limits.maxInputTokens??Number.MAX_SAFE_INTEGER)||nextOutput>Number(auth.limits.maxOutputTokens??Number.MAX_SAFE_INTEGER)};});const result=tx();if(result.exceeded)throw new Error("token stop limit exceeded after latest completed request");return result.record; }
  revokeBudgetAuthorization(id:string):void { this.db.prepare("UPDATE budget_authorizations_v2 SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(new Date().toISOString(),id); }
  deleteV2Run(id:string):{deleted:boolean;reason?:string} { const run=this.getV2Run(id);if(!run)return{deleted:false,reason:"not_found"};if(["queued","running"].includes(run.status))return{deleted:false,reason:"active"};this.db.prepare("DELETE FROM verification_runs_v2 WHERE id=?").run(id);return{deleted:true}; }
  createReferenceCohortV2(input:{label:string;vendor:string;product:string;surface:string;status:string}):ReferenceCohortV2Record { const id=randomUUID(),createdAt=new Date().toISOString();this.db.prepare("INSERT INTO reference_cohorts_v2(id,label,vendor,product,surface,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id,input.label,input.vendor,input.product,input.surface,input.status,createdAt,createdAt);return this.getReferenceCohortV2(id)!; }
  getReferenceCohortV2(id:string):ReferenceCohortV2Record|undefined { const row=this.db.prepare("SELECT * FROM reference_cohorts_v2 WHERE id=?").get(id) as any;return row?{id:row.id,label:row.label,vendor:row.vendor,product:row.product,surface:row.surface,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at}:undefined; }
  listReferenceCohortsV2():ReferenceCohortV2Record[] { return this.db.prepare("SELECT * FROM reference_cohorts_v2 ORDER BY created_at DESC").all().map((row:any)=>({id:row.id,label:row.label,vendor:row.vendor,product:row.product,surface:row.surface,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at})); }
  saveReferenceVersionV2(input:Omit<ReferenceVersionV2Record,"id"|"createdAt">):ReferenceVersionV2Record { const id=randomUUID(),createdAt=new Date().toISOString();this.db.prepare(`INSERT INTO reference_versions_v2(id,cohort_id,level,identity_json,protocol,collected_at,last_confirmed_at,freshness_status,quality_status,manifest_hash,fingerprint_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.cohortId??null,input.level,JSON.stringify(input.identity),input.protocol,input.collectedAt,input.lastConfirmedAt,input.freshnessStatus,input.qualityStatus,input.manifestHash,JSON.stringify(input.fingerprint),createdAt);return this.getReferenceVersionV2(id)!; }
  publishReferenceEnrollment(input:{runId:string;cohort:{label:string;vendor:string;product:string;surface:string};version:{level:string;identity:any;protocol:string;collectedAt:string;manifestHash:string;fingerprint:any};quality:any;manifest:any}):{cohort:ReferenceCohortV2Record;version:ReferenceVersionV2Record} { const tx=this.db.transaction(()=>{const cohort=this.createReferenceCohortV2({...input.cohort,status:"active"});const version=this.saveReferenceVersionV2({cohortId:cohort.id,level:input.version.level,identity:input.version.identity,protocol:input.version.protocol,collectedAt:input.version.collectedAt,lastConfirmedAt:input.version.collectedAt,freshnessStatus:"current",qualityStatus:"approved",manifestHash:input.version.manifestHash,fingerprint:input.version.fingerprint});const result={referenceEnrollment:{cohortId:cohort.id,referenceVersionId:version.id,label:cohort.label,level:version.level,identity:version.identity,protocol:version.protocol,collectedAt:input.version.collectedAt,manifestHash:input.version.manifestHash},quality:input.quality,manifest:input.manifest};this.db.prepare("UPDATE verification_runs_v2 SET reference_id=?,status='completed',phase='completed',progress=1,finished_at=?,result_json=? WHERE id=? AND mode='reference_enrollment'").run(version.id,input.version.collectedAt,JSON.stringify(result),input.runId);return{cohort,version};});return tx(); }
  getReferenceVersionV2(id:string):ReferenceVersionV2Record|undefined { const row=this.db.prepare("SELECT * FROM reference_versions_v2 WHERE id=?").get(id) as any;return row?{id:row.id,cohortId:row.cohort_id??undefined,level:row.level,identity:parse(row.identity_json,{}),protocol:row.protocol,collectedAt:row.collected_at,lastConfirmedAt:row.last_confirmed_at,freshnessStatus:row.freshness_status,qualityStatus:row.quality_status,manifestHash:row.manifest_hash,fingerprint:parse(row.fingerprint_json,{}),createdAt:row.created_at}:undefined; }
  listReferenceVersionsV2(cohortId?:string):ReferenceVersionV2Record[] { const rows=(cohortId?this.db.prepare("SELECT id FROM reference_versions_v2 WHERE cohort_id=? ORDER BY created_at DESC").all(cohortId):this.db.prepare("SELECT id FROM reference_versions_v2 ORDER BY created_at DESC").all()) as any[];return rows.map((row)=>this.getReferenceVersionV2(row.id)!); }
  addReferenceGovernanceEvent(referenceVersionId:string,eventType:string,details:any):ReferenceGovernanceEventRecord { const current=this.getReferenceVersionV2(referenceVersionId);if(!current)throw new Error("reference version not found");const id=randomUUID(),createdAt=new Date().toISOString();const tx=this.db.transaction(()=>{this.db.prepare("INSERT INTO reference_governance_events_v2(id,reference_version_id,event_type,details_json,created_at) VALUES(?,?,?,?,?)").run(id,referenceVersionId,eventType,JSON.stringify(details),createdAt);if(eventType==="confirmed")this.db.prepare("UPDATE reference_versions_v2 SET last_confirmed_at=?,freshness_status='current',quality_status='approved' WHERE id=?").run(createdAt,referenceVersionId);else if(eventType==="marked_stale")this.db.prepare("UPDATE reference_versions_v2 SET freshness_status='stale',quality_status='approved' WHERE id=?").run(referenceVersionId);else if(eventType==="review_required")this.db.prepare("UPDATE reference_versions_v2 SET quality_status='review_required' WHERE id=?").run(referenceVersionId);else if(eventType==="quarantined")this.db.prepare("UPDATE reference_versions_v2 SET quality_status='quarantined' WHERE id=?").run(referenceVersionId);else if(eventType==="superseded")this.db.prepare("UPDATE reference_versions_v2 SET quality_status='superseded' WHERE id=?").run(referenceVersionId);else if(eventType==="archived"&&current.cohortId)this.db.prepare("UPDATE reference_cohorts_v2 SET status='archived',updated_at=? WHERE id=?").run(createdAt,current.cohortId);});tx();return{id,referenceVersionId,eventType,details,createdAt}; }
  listReferenceGovernanceEvents(referenceVersionId:string):ReferenceGovernanceEventRecord[] { return this.db.prepare("SELECT * FROM reference_governance_events_v2 WHERE reference_version_id=? ORDER BY created_at").all(referenceVersionId).map((row:any)=>({id:row.id,referenceVersionId:row.reference_version_id,eventType:row.event_type,details:parse(row.details_json,{}),createdAt:row.created_at})); }
  createShareReport(runId:string,report:any,reportHash:string,expiresAt:string):ShareReportRecord { const id=randomUUID(),createdAt=new Date().toISOString();this.db.prepare("INSERT INTO share_reports_v2(id,run_id,report_hash,report_json,expires_at,created_at) VALUES(?,?,?,?,?,?)").run(id,runId,reportHash,JSON.stringify(report),expiresAt,createdAt);return this.getShareReport(id)!; }
  getShareReport(id:string):ShareReportRecord|undefined { const row=this.db.prepare("SELECT * FROM share_reports_v2 WHERE id=?").get(id) as any;return row?{id:row.id,runId:row.run_id,reportHash:row.report_hash,report:parse(row.report_json,{}),expiresAt:row.expires_at,revokedAt:row.revoked_at??undefined,createdAt:row.created_at}:undefined; }
  revokeShareReport(id:string):void { this.db.prepare("UPDATE share_reports_v2 SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(new Date().toISOString(),id); }
  settings():SettingsRecord { return { concurrency:this.setting("concurrency",4), tauMatch:this.setting("tauMatch",0.12), tauMid:this.setting("tauMid",0.22), retainRaw:this.setting("retainRaw",false) }; }
  saveSettings(input:SettingsRecord):SettingsRecord { const put=this.db.prepare("INSERT OR REPLACE INTO settings(key,value_json) VALUES(?,?)"); const tx=this.db.transaction(()=>Object.entries(input).forEach(([k,v])=>put.run(k,JSON.stringify(v)))); tx(); return this.settings(); }
  private setting<T>(key:string,fallback:T):T { const row=this.db.prepare("SELECT value_json FROM settings WHERE key=?").get(key) as any; return parse(row?.value_json??null,fallback); }
}

function mapProvider(row:any):ProviderRecord { return {id:row.id,name:row.name,protocol:row.protocol,baseUrl:row.base_url,models:parse(row.models_json,[]),role:row.role,secretRef:row.secret_ref,headers:parse(row.headers_json,{}),createdAt:row.created_at,updatedAt:row.updated_at,deletedAt:row.deleted_at??undefined}; }
function mapReference(row:any):ReferenceRecord { return {id:row.id,providerId:row.provider_id,modelClaimed:row.model_claimed,label:row.label,baseUrl:row.base_url,enrolledAt:row.enrolled_at,batteryVersion:row.battery_version,normalizeVersion:row.normalize_version,systemPromptVersion:row.system_prompt_version,cellIds:parse(row.cell_ids_json,[]),fingerprint:parse(row.fingerprint_json,{})}; }
function mapRun(row:any):RunRecord { return {id:row.id,kind:row.kind,status:row.status,providerId:row.provider_id,model:row.model,claimedModel:row.claimed_model??undefined,referenceId:row.reference_external_id??row.reference_id??undefined,profile:row.profile,createdAt:row.created_at,startedAt:row.started_at??undefined,finishedAt:row.finished_at??undefined,progress:row.progress,successCount:row.success_count??0,failCount:row.fail_count??0,result:parse(row.result_json,null)??undefined,error:row.error??undefined,abortRequested:Boolean(row.abort_requested)}; }
function mapV2Run(row:any):V2RunRecord { return {id:row.id,mode:row.mode,status:row.status,phase:row.phase,providerId:row.provider_id,referenceProviderId:row.reference_provider_id??undefined,referenceId:row.reference_id??undefined,model:row.model,referenceModel:row.reference_model??undefined,profile:row.profile,protocolComparability:row.protocol_comparability,referenceLevel:row.reference_level,identity:parse(row.identity_json,{}),budget:parse(row.budget_json,{}),createdAt:row.created_at,startedAt:row.started_at??undefined,finishedAt:row.finished_at??undefined,progress:row.progress,successCount:row.success_count??0,failCount:row.fail_count??0,result:parse(row.result_json,null)??undefined,error:row.error??undefined,abortRequested:Boolean(row.abort_requested)}; }

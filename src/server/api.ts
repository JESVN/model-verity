import { access } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { adapterFor } from "../core/adapters/registry.js";
import { AdapterError, type AdapterId } from "../core/adapters/types.js";
import { PROFILE_BUDGETS, type RunProfile } from "../core/run/planner.js";
import { Repository, type ProviderRecord, type SettingsRecord } from "./db.js";
import { RunManager } from "./run-manager.js";
import { maskSecret, SecretStore } from "./secrets.js";
import { ConnectionTestManager } from "./connection-tests.js";
import { V2RunManager } from "./v2-run-manager.js";
import { ZenodoUpdateManager, ZenodoUpdateError } from "./zenodo-update.js";
import { CredentialSessionStore } from "./credential-sessions.js";
import { createHash } from "node:crypto";
import { ReportBindingStore } from "./report-binding.js";
import { validateCalibrationArtifact, artifactHash } from "../core/v2/calibration.js";
import { V2_FRAMEWORK_VERSION, type CalibrationArtifact } from "../core/v2/types.js";
import { referenceFreshnessAt } from "../core/v2/reference-freshness.js";
import { V3_SCORING_POLICY_VERSION } from "../core/v3/scoring.js";
import {
  BUILTIN_REFERENCE_PREFIX,
  builtinLibraryInfo,
  getBuiltinReference,
  listBuiltinReferences,
} from "./builtin-library.js";

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(payload);
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const value = Buffer.from(chunk); size += value.length;
    if (size > 256 * 1024) throw new HttpError(413, "request body too large");
    chunks.push(value);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { throw new HttpError(400, "invalid JSON"); }
}
function string(value: unknown, name: string, max = 500): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `invalid ${name}`); return value.trim(); }
function id(value: unknown, name = "id"): string { return string(value, name, 100); }
function url(value: unknown): string { const raw=string(value,"baseUrl",2000); let parsed:URL; try { parsed=new URL(raw); } catch { throw new HttpError(400,"invalid baseUrl"); } if(!["http:","https:"].includes(parsed.protocol)) throw new HttpError(400,"baseUrl must use http or https"); if(parsed.username||parsed.password||parsed.search||parsed.hash)throw new HttpError(400,"baseUrl must not contain userinfo, query, or fragment"); return raw.replace(/\/+$/,""); }
function profile(value: unknown): RunProfile { if (!Object.hasOwn(PROFILE_BUDGETS, String(value))) throw new HttpError(400,"invalid profile"); return value as RunProfile; }
function cleanHeaders(value: unknown): Record<string,string> { if(value==null)return{}; if(typeof value!=="object"||Array.isArray(value))throw new HttpError(400,"invalid headers"); const out:Record<string,string>={}; for(const [k,v] of Object.entries(value)){if(typeof v!=="string"||k.length>100||v.length>2000||/authorization|proxy-authorization|api[-_]key|cookie|^host$|^connection$|^content-length$|^transfer-encoding$/i.test(k))throw new HttpError(400,"secret or transport headers are not supported; use apiKey"); out[k]=v;} return out; }

export class Api {
  readonly runs: RunManager;
  readonly connectionTests: ConnectionTestManager;
  readonly v2Runs: V2RunManager;
  readonly credentialSessions = new CredentialSessionStore();
  readonly reportBindings:ReportBindingStore;
  readonly libraryUpdate: ZenodoUpdateManager;
  constructor(readonly repo: Repository, readonly secrets: SecretStore, readonly dataDir: string) {
    this.runs = new RunManager(repo, secrets);
    this.connectionTests = new ConnectionTestManager(repo, secrets);
    this.reportBindings=new ReportBindingStore(dataDir);
    this.v2Runs = new V2RunManager(repo, secrets, this.credentialSessions, this.reportBindings);
    this.libraryUpdate = new ZenodoUpdateManager({ dataDir });
  }

  async shutdown(): Promise<void> {
    await this.connectionTests.shutdown();
    await this.runs.shutdown();
    await this.v2Runs.shutdown();
    this.credentialSessions.clear();
  }

  private async maintenance(): Promise<boolean> {
    try { await access(join(this.dataDir, "maintenance.json")); return true; }
    catch { return false; }
  }

  private async requireWritable(): Promise<void> {
    if (await this.maintenance()) throw new HttpError(503, "system maintenance in progress; try again later");
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith("/api/")) return false;
    const method=req.method??"GET";
    if(pathname==="/api/health") return false;
    if(pathname==="/api/status" && method==="GET") { sendJson(res,200,{maintenance:await this.maintenance(),activeRun:Boolean(this.repo.activeRunCount()||this.repo.activeV2RunCount()),activeConnectionTest:this.connectionTests.active()}); return true; }
    if(pathname==="/api/bootstrap" && method==="GET") {
      const providers=await Promise.all(this.repo.listProviders().map((p)=>this.publicProvider(p)));
      const versions=this.repo.listReferenceVersionsV2().filter((value)=>value.qualityStatus==="approved"&&value.freshnessStatus!=="stale").map((value)=>publicVersionReference(this.repo,value));
      const references=[...versions,...listBuiltinReferences().map(publicBuiltinReference),...this.repo.listReferences().map(publicReference)];
      const runs=this.repo.listV2Runs().filter(isCurrentScoredRun);
      const status={maintenance:await this.maintenance(),activeRun:Boolean(this.repo.activeRunCount()||this.repo.activeV2RunCount()),activeConnectionTest:this.connectionTests.active()};
      sendJson(res,200,{providers,references,runs,status}); return true;
    }
    if (["POST", "PUT", "PATCH"].includes(method) && !(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "content-type must be application/json");
    }
    if(pathname==="/api/providers" && method==="GET") { const records=await Promise.all(this.repo.listProviders().map((p)=>this.publicProvider(p))); sendJson(res,200,{items:records}); return true; }
    if(pathname==="/api/providers/models" && method==="POST") {
      const input=await body(req);
      const providerId=input.providerId? id(input.providerId,"providerId"):undefined;
      const saved=providerId?this.repo.getProvider(providerId):undefined;
      if(providerId&&!saved)throw new HttpError(404,"provider not found");
      const selectedProtocol=protocol(input.protocol??saved?.protocol);
      const baseUrl=url(input.baseUrl??saved?.baseUrl);
      const suppliedKey=input.apiKey!=null&&input.apiKey!==""?string(input.apiKey,"apiKey",10000):null;
      if(!suppliedKey&&!saved)throw new HttpError(400,"apiKey is required to fetch models");
      const headers=cleanHeaders(input.headers??saved?.headers);
      const apiKey=suppliedKey??(saved?await this.secrets.get(saved.secretRef):null);
      if(!apiKey)throw new HttpError(400,"apiKey is required to fetch models");
      try {
        const discovered=await adapterFor(selectedProtocol).listModels({baseUrl,apiKey,headers,timeoutMs:20_000});
        sendJson(res,200,{items:discovered});
      } catch(error) {
        const status=error instanceof AdapterError?error.status:undefined;
        const message=redactError(error instanceof Error?error.message:String(error),[apiKey]);
        throw new HttpError(502,`model discovery failed${status?` (HTTP ${status})`:""}: ${message}`);
      }
      return true;
    }
    if(pathname==="/api/providers" && method==="POST") { const input=await body(req); const providerId=input.id? id(input.id):undefined; const old=providerId?this.repo.getProvider(providerId):undefined; if(providerId&&!old)throw new HttpError(404,"provider not found"); if(providerId&&this.connectionTests.isProviderActive(providerId))throw new HttpError(409,"provider has an active connection test"); const selectedProtocol=protocol(input.protocol); const baseUrl=url(input.baseUrl); const suppliedKey=input.apiKey!=null&&input.apiKey!==""?string(input.apiKey,"apiKey",10000):null; let secretRef=old?.secretRef; if(suppliedKey){ secretRef=await this.secrets.set(providerId??crypto.randomUUID(),suppliedKey); } if(!secretRef)throw new HttpError(400,"apiKey is required"); const record=this.repo.saveProvider({id:providerId,name:string(input.name,"name",120),protocol:selectedProtocol,baseUrl,models:models(input.models),role:role(input.role),secretRef,headers:cleanHeaders(input.headers)}); if(old?.secretRef && old.secretRef!==secretRef)await this.secrets.delete(old.secretRef); sendJson(res,providerId?200:201,await this.publicProvider(record)); return true; }
    const providerUsageMatch=pathname.match(/^\/api\/providers\/([^/]+)\/usage$/);
    if(providerUsageMatch && method==="GET") { const providerId=decodeURIComponent(providerUsageMatch[1]); if(!this.repo.getProvider(providerId))throw new HttpError(404,"provider not found"); sendJson(res,200,this.repo.providerUsage(providerId)); return true; }
    const connectionCreateMatch=pathname.match(/^\/api\/providers\/([^/]+)\/connection-tests$/);
    if(connectionCreateMatch && method==="POST") {
      await this.requireWritable();
      const input=await body(req); const providerId=decodeURIComponent(connectionCreateMatch[1]); const selectedProtocol=protocol(input.protocol);
      try { sendJson(res,202,await this.connectionTests.create(providerId,string(input.model,"model",300),selectedProtocol)); }
      catch(error) { const message=error instanceof Error?error.message:String(error); throw new HttpError(/not found/.test(message)?404:409,message); }
      return true;
    }
    const connectionMatch=pathname.match(/^\/api\/connection-tests\/([^/]+)$/);
    if(connectionMatch && method==="GET") { const session=this.connectionTests.get(decodeURIComponent(connectionMatch[1])); if(!session)throw new HttpError(404,"connection test not found"); sendJson(res,200,session); return true; }
    const connectionCancelMatch=pathname.match(/^\/api\/connection-tests\/([^/]+)\/cancel$/);
    if(connectionCancelMatch && method==="POST") { const session=this.connectionTests.cancel(decodeURIComponent(connectionCancelMatch[1])); if(!session)throw new HttpError(404,"connection test not found"); sendJson(res,200,session); return true; }
    const providerMatch=pathname.match(/^\/api\/providers\/([^/]+)$/);
    if(providerMatch && method==="DELETE") { await this.requireWritable(); const providerId=decodeURIComponent(providerMatch[1]); const usage=this.repo.providerUsage(providerId); if(this.connectionTests.isProviderActive(providerId))throw new HttpError(409,"provider has an active connection test"); if(usage.activeRuns)throw new HttpError(409,"provider has active runs"); if(usage.references)throw new HttpError(409,"delete provider references first"); const old=this.repo.deleteProvider(providerId); if(!old)throw new HttpError(404,"provider not found"); await this.secrets.delete(old.secretRef); sendJson(res,200,{ok:true}); return true; }
    if(pathname==="/api/references" && method==="GET") { const versions=this.repo.listReferenceVersionsV2().filter((value)=>value.qualityStatus==="approved"&&value.freshnessStatus!=="stale").map((value)=>publicVersionReference(this.repo,value));sendJson(res,200,{items:[...versions,...listBuiltinReferences().map(publicBuiltinReference),...this.repo.listReferences().map(publicReference)],library:builtinLibraryInfo()}); return true; }
    const refUsageMatch=pathname.match(/^\/api\/references\/([^/]+)\/usage$/);
    if(refUsageMatch && method==="GET") { const referenceId=decodeURIComponent(refUsageMatch[1]); if(!this.repo.getReference(referenceId))throw new HttpError(404,"reference not found"); sendJson(res,200,this.repo.referenceUsage(referenceId)); return true; }
    const refMatch=pathname.match(/^\/api\/references\/([^/]+)$/);
    if(refMatch && method==="DELETE") { await this.requireWritable(); const referenceId=decodeURIComponent(refMatch[1]); if(referenceId.startsWith(BUILTIN_REFERENCE_PREFIX))throw new HttpError(409,"built-in references are read-only"); if(!this.repo.getReference(referenceId))throw new HttpError(404,"reference not found"); if(this.repo.referenceUsage(referenceId).activeRuns)throw new HttpError(409,"reference has active runs"); this.repo.deleteReference(referenceId); sendJson(res,200,{ok:true}); return true; }
    if(pathname==="/api/v2/policy" && method==="GET") { sendJson(res,200,{strongConclusionsEnabled:false,longTermStability:"not_assessed"});return true; }
    if(pathname==="/api/v2/credential-sessions"&&method==="POST") { await this.requireWritable();const input=await body(req);const roleValue=input.endpointRole==="reference"?"reference":input.endpointRole==="target"?"target":null;if(!roleValue)throw new HttpError(400,"invalid endpointRole");const session=this.credentialSessions.create({endpointRole:roleValue,secret:string(input.apiKey,"apiKey",10000),ttlMs:integer(input.ttlMinutes??15,1,60,"ttlMinutes")*60_000});sendJson(res,201,session);return true; }
    if(pathname==="/api/v2/budget-authorizations"&&method==="POST") { await this.requireWritable();const input=await body(req);const providerIds=Array.isArray(input.providerIds)?input.providerIds.map((v:unknown)=>id(v,"providerId")):[];const modelsValue=Array.isArray(input.models)?input.models.map((v:unknown)=>string(v,"model",300)):[];if(!providerIds.length||!modelsValue.length)throw new HttpError(400,"budget requires allowed providers and models");const limits={maxEndpointRequests:integer(input.maxEndpointRequests,1,4000,"maxEndpointRequests"),maxInputTokens:integer(input.maxInputTokens,1,10_000_000,"maxInputTokens"),maxOutputTokens:integer(input.maxOutputTokens,1,1_000_000,"maxOutputTokens"),maxAttemptsPerEndpoint:integer(input.maxAttemptsPerEndpoint??1,1,3,"maxAttemptsPerEndpoint")};const expiresAt=string(input.expiresAt,"expiresAt",100);if(Date.parse(expiresAt)<=Date.now())throw new HttpError(400,"budget must not be expired");sendJson(res,201,this.repo.createBudgetAuthorization({limits,allowed:{providerIds,models:modelsValue},expiresAt}));return true; }
    if(pathname==="/api/v2/reference-cohorts"&&method==="GET") { sendJson(res,200,{items:this.repo.listReferenceCohortsV2()});return true; }
    if(pathname==="/api/v2/reference-cohorts"&&method==="POST") { await this.requireWritable();const input=await body(req);sendJson(res,201,this.repo.createReferenceCohortV2({label:string(input.label,"label",200),vendor:string(input.vendor,"vendor",200),product:string(input.product,"product",300),surface:surface(input.surface),status:referenceCohortStatus(input.status??"active")}));return true; }
    if(pathname==="/api/v2/reference-versions"&&method==="GET") { const cohortId=new URL(req.url??"/","http://localhost").searchParams.get("cohortId")??undefined;sendJson(res,200,{items:this.repo.listReferenceVersionsV2(cohortId)});return true; }
    if(pathname==="/api/v2/reference-versions"&&method==="POST") { throw new HttpError(410,"direct reference version import is retired; use a reference enrollment plan"); }
    if(pathname==="/api/v2/references/enrollment-plans"&&method==="POST") { await this.requireWritable();if(this.connectionTests.active()||this.repo.activeRunCount()||this.repo.activeV2RunCount())throw new HttpError(409,"another task is active");const input=await body(req);const providerId=id(input.providerId,"providerId"),provider=this.repo.getProvider(providerId);if(!provider)throw new HttpError(404,"provider not found");if(provider.role==="audit")throw new HttpError(400,"provider is not configured as a trusted reference");const model=string(input.model,"model",300);if(!provider.models.includes(model))throw new HttpError(400,"model is not configured for provider");const selectedProfile=["quick","audit","full"].includes(input.profile)?String(input.profile):"audit";const expectedRequests=selectedProfile==="quick"?20:selectedProfile==="full"?240:80;const budget=input.budget??{},authorizationId=id(budget.authorizationId,"authorizationId"),authorization=this.repo.getBudgetAuthorization(authorizationId);if(!authorization)throw new HttpError(404,"budget authorization not found");const maxPairs=integer(budget.maxPairs,1,1000,"maxPairs"),maxEndpointRequests=integer(budget.maxEndpointRequests,1,4000,"maxEndpointRequests"),expiresAt=string(budget.expiresAt,"expiresAt",100);if(Date.parse(expiresAt)<=Date.now())throw new HttpError(400,"budget must not be expired");if(maxPairs!==expectedRequests||maxEndpointRequests!==expectedRequests)throw new HttpError(400,`reference ${selectedProfile} requires exactly ${expectedRequests} requests`);if(maxEndpointRequests>Number(authorization.limits.maxEndpointRequests??0))throw new HttpError(400,"run budget exceeds authorization");const level=input.referenceLevel==="L2"?"L2":input.referenceLevel==="L3"?"L3":null;if(!level)throw new HttpError(400,"self-built references must use L2 or L3");const identity=input.identity?.declared??{};const run=this.repo.createV2Run({mode:"reference_enrollment",providerId,model,profile:selectedProfile,protocolComparability:"P1",referenceLevel:level,identity:{declared:{vendor:string(identity.vendor,"vendor",200),product:string(identity.product,"product",300),surface:surface(identity.surface),...(identity.snapshot?{snapshot:string(identity.snapshot,"snapshot",300)}:{})},observed:{requestedModel:model,targetProtocol:protocol(input.protocol??provider.protocol)},enrollmentLabel:string(input.label,"label",200)},budget:{authorizationId,maxPairs,maxEndpointRequests,maxAttemptsPerEndpoint:1,expiresAt,targetCredentialSessionId:input.credentialSessionId?string(input.credentialSessionId,"credentialSessionId",100):undefined}});if(input.credentialSessionId)this.credentialSessions.bind(String(input.credentialSessionId),run.id);this.v2Runs.launch(run.id);sendJson(res,202,run);return true; }
    const referenceVersionMatch=pathname.match(/^\/api\/v2\/reference-versions\/([^/]+)$/);
    if(referenceVersionMatch&&method==="GET") { const version=this.repo.getReferenceVersionV2(decodeURIComponent(referenceVersionMatch[1]));if(!version)throw new HttpError(404,"reference version not found");sendJson(res,200,{...version,governanceEvents:this.repo.listReferenceGovernanceEvents(version.id)});return true; }
    const governanceMatch=pathname.match(/^\/api\/v2\/reference-versions\/([^/]+)\/governance-events$/);
    if(governanceMatch&&method==="POST") { await this.requireWritable();const input=await body(req);const referenceVersionId=decodeURIComponent(governanceMatch[1]);try{const event=this.repo.addReferenceGovernanceEvent(referenceVersionId,governanceEvent(input.eventType),input.details??{});sendJson(res,201,{...event,version:this.repo.getReferenceVersionV2(referenceVersionId)});}catch(error){throw new HttpError(404,error instanceof Error?error.message:String(error));}return true; }
    if(pathname==="/api/v2/calibration/profiles" && method==="GET") { sendJson(res,200,{items:this.repo.listCalibrations()}); return true; }
    if(pathname==="/api/v2/references/update/status" && method==="GET") { sendJson(res,200,this.libraryUpdate.status()); return true; }
    if(pathname==="/api/v2/references/update/check" && method==="POST") { await this.requireWritable(); const input=await body(req); try { sendJson(res,200,await this.libraryUpdate.check(Boolean(input.refresh))); } catch(error){ if(error instanceof ZenodoUpdateError) throw new HttpError(error.status,error.message); throw error; } return true; }
    if(pathname==="/api/v2/references/update/prepare" && method==="POST") { await this.requireWritable(); if(this.connectionTests.active()||this.repo.activeRunCount()||this.repo.activeV2RunCount())throw new HttpError(409,"another task is active"); try { sendJson(res,202,this.libraryUpdate.prepare()); } catch(error){ if(error instanceof ZenodoUpdateError) throw new HttpError(error.status,error.message); throw error; } return true; }
    const updateCancelMatch=pathname.match(/^\/api\/v2\/references\/update\/jobs\/([^/]+)\/cancel$/);
    if(updateCancelMatch&&method==="POST") { await this.requireWritable(); this.libraryUpdate.cancelPrepare(); sendJson(res,200,this.libraryUpdate.status()); return true; }
    const updateJobMatch=pathname.match(/^\/api\/v2\/references\/update\/jobs\/([^/]+)$/);
    if(updateJobMatch&&method==="GET") { const job=this.libraryUpdate.jobFor(updateJobMatch[1]); if(!job)throw new HttpError(404,"update job not found"); sendJson(res,200,job); return true; }
    if(pathname==="/api/v2/references/update" && method==="POST") { await this.requireWritable(); if(this.connectionTests.active()||this.repo.activeRunCount()||this.repo.activeV2RunCount())throw new HttpError(409,"another task is active"); const input=await body(req); const modelIds=Array.isArray(input.modelIds)?input.modelIds.map((v:unknown)=>string(v,"modelId",300)):[]; const action=input.action==="download"?"download":"update"; try { sendJson(res,202,this.libraryUpdate.startApply(modelIds,action)); } catch(error){ if(error instanceof ZenodoUpdateError) throw new HttpError(error.status,error.message); throw error; } return true; }
    if(pathname==="/api/v2/references/update/rollback" && method==="POST") { await this.requireWritable(); if(this.connectionTests.active()||this.repo.activeRunCount()||this.repo.activeV2RunCount())throw new HttpError(409,"another task is active"); try { sendJson(res,200,this.libraryUpdate.rollback()); } catch(error){ if(error instanceof ZenodoUpdateError) throw new HttpError(error.status,error.message); throw error; } return true; }
    if(pathname==="/api/v2/references/update/cache/clean" && method==="POST") { await this.requireWritable(); sendJson(res,200,this.libraryUpdate.cleanCache()); return true; }
    if(pathname==="/api/v2/references/update/proxy" && method==="GET") { sendJson(res,200,this.libraryUpdate.proxyInfo()); return true; }
    if(pathname==="/api/v2/references/update/proxy" && method==="POST") { await this.requireWritable(); const input=await body(req); try { const url=input.url&&typeof input.url==="string"&&input.url.trim() ? String(input.url).trim() : null; sendJson(res,200,this.libraryUpdate.setProxy(url)); } catch(error){ if(error instanceof ZenodoUpdateError) throw new HttpError(error.status,error.message); throw error; } return true; }
    if(pathname==="/api/v2/references/update/proxy/test" && method==="POST") { await this.requireWritable(); try { sendJson(res,200,await this.libraryUpdate.testProxy()); } catch(error){ if(error instanceof ZenodoUpdateError) throw new HttpError(error.status,error.message); throw error; } return true; }
    if(pathname==="/api/v2/calibration/import" && method==="POST") { await this.requireWritable(); if(process.env.MODEL_VERITY_ALLOW_CALIBRATION_IMPORT!=="1")throw new HttpError(403,"calibration import requires local administrator enablement"); const input=await body(req); const artifact=validateCalibrationArtifact(input.artifact as CalibrationArtifact); const {manifestHash,...unsigned}=artifact; const expected=artifactHash(unsigned); if(artifact.manifestHash!==expected)throw new HttpError(400,"calibration manifest hash mismatch"); const saved=this.repo.saveCalibration({id:artifact.id,version:artifact.version,vendor:artifact.vendor,product:artifact.product,surface:artifact.surface,profile:artifact.profile,artifact,active:Boolean(input.active),createdAt:artifact.createdAt});sendJson(res,201,saved);return true; }
    if(pathname==="/api/v2/verification-runs" && method==="GET") { sendJson(res,200,{items:this.repo.listV2Runs().filter(isCurrentScoredRun)}); return true; }
    if(pathname==="/api/v2/references" && method==="GET") { sendJson(res,200,{items:[...this.repo.listReferenceVersionsV2().map((value)=>publicVersionReference(this.repo,value)),...listBuiltinReferences().map(publicBuiltinReference),...this.repo.listReferences().map((ref:any)=>({...publicReference(ref),level:'L3',identity:{vendor:'unknown',product:ref.modelClaimed,surface:'unknown'},freshnessStatus:'usable',qualityStatus:'approved'}))]});return true; }
    if(pathname==="/api/v2/history" && method==="GET") { sendJson(res,200,{items:this.repo.listV2Runs().filter(isCurrentScoredRun).map((run)=>({...run,frameworkVersion:V2_FRAMEWORK_VERSION}))});return true; }
    if(pathname==="/api/v2/verification-runs" && method==="POST") { await this.requireWritable(); if(this.connectionTests.active()||this.repo.activeRunCount()||this.repo.activeV2RunCount())throw new HttpError(409,"another task is active"); const input=await body(req); const providerId=id(input.providerId,"providerId");const provider=this.repo.getProvider(providerId);if(!provider)throw new HttpError(404,"provider not found");const mode=input.mode==="paired"?"paired":input.mode==="screening"?"screening":null;if(!mode)throw new HttpError(400,"invalid verification mode");const protocolComparability=["P1","P2","P3"].includes(input.protocolComparability)?input.protocolComparability:null;if(!protocolComparability)throw new HttpError(400,"invalid protocol comparability");const referenceLevel=["L1","L2","L3"].includes(input.referenceLevel)?input.referenceLevel:null;if(!referenceLevel)throw new HttpError(400,"invalid reference level");const maxPairs=integer(input.budget?.maxPairs,1,1000,"maxPairs");const maxEndpointRequests=integer(input.budget?.maxEndpointRequests,1,4000,"maxEndpointRequests");const expiresAt=string(input.budget?.expiresAt,"expiresAt",100);if(Date.parse(expiresAt)<=Date.now())throw new HttpError(400,"budget must not be expired");const authorizationId=id(input.budget?.authorizationId,"authorizationId");const authorization=this.repo.getBudgetAuthorization(authorizationId);if(!authorization)throw new HttpError(404,"budget authorization not found");if(maxEndpointRequests>Number(authorization.limits.maxEndpointRequests??0)||input.budget?.maxAttemptsPerEndpoint>Number(authorization.limits.maxAttemptsPerEndpoint??1))throw new HttpError(400,"run budget exceeds authorization");if(mode==="screening"){const rid=id(input.referenceId,"referenceId");const version=this.repo.getReferenceVersionV2(rid);if(!this.repo.getReference(rid)&&!getBuiltinReference(rid)&&!version)throw new HttpError(404,"reference fingerprint not found");if(version&&(version.qualityStatus!=="approved"||version.freshnessStatus==="stale"))throw new HttpError(409,"reference version is not currently usable");if(protocolComparability!=="P3"){if(!version)throw new HttpError(400,"research or legacy references require P3 diagnostic comparability");const declared=input.identity?.declared??{};if(!sameComparableIdentity(declared,version.identity))throw new HttpError(400,"P1/P2 requires matching non-unknown product and surface");const targetProtocol=protocol(input.identity?.observed?.targetProtocol??provider.protocol);if(protocolComparability==="P1"&&targetProtocol!==version.protocol)throw new HttpError(400,"P1 requires identical target and reference protocols");}}if(mode==="paired"&&input.referenceProviderId){const refProvider=this.repo.getProvider(id(input.referenceProviderId,"referenceProviderId"));if(!refProvider)throw new HttpError(404,"reference provider not found");const targetProtocol=protocol(input.identity?.observed?.targetProtocol??provider.protocol);const referenceProtocol=protocol(input.identity?.observed?.referenceProtocol??refProvider.protocol);if(protocolComparability!=="P3"&&!sameComparableIdentity(input.identity?.declared??{},input.identity?.reference??{}))throw new HttpError(400,"P1/P2 requires matching non-unknown product and surface");if(protocolComparability==="P1"&&targetProtocol!==referenceProtocol)throw new HttpError(400,"P1 requires identical target and reference protocols");}const run=this.repo.createV2Run({mode,providerId,referenceProviderId:input.referenceProviderId?id(input.referenceProviderId,"referenceProviderId"):undefined,referenceId:input.referenceId?id(input.referenceId,"referenceId"):undefined,model:string(input.model,"model",300),referenceModel:input.referenceModel?string(input.referenceModel,"referenceModel",300):undefined,profile:["quick","audit","full"].includes(input.profile)?input.profile:"audit",protocolComparability,referenceLevel,identity:input.identity??{declared:{vendor:"unknown",product:String(input.model),surface:"unknown"}},budget:{authorizationId,maxPairs,maxEndpointRequests,maxAttemptsPerEndpoint:integer(input.budget?.maxAttemptsPerEndpoint??1,1,3,"maxAttemptsPerEndpoint"),expiresAt,targetCredentialSessionId:input.targetCredentialSessionId?string(input.targetCredentialSessionId,"targetCredentialSessionId",100):undefined,referenceCredentialSessionId:input.referenceCredentialSessionId?string(input.referenceCredentialSessionId,"referenceCredentialSessionId",100):undefined}});if(input.targetCredentialSessionId)this.credentialSessions.bind(String(input.targetCredentialSessionId),run.id);if(input.referenceCredentialSessionId)this.credentialSessions.bind(String(input.referenceCredentialSessionId),run.id);this.v2Runs.launch(run.id);sendJson(res,202,run);return true; }
    const v2EvidenceMatch=pathname.match(/^\/api\/v2\/verification-runs\/([^/]+)\/evidence$/);
    if(v2EvidenceMatch&&method==="GET") { const runId=decodeURIComponent(v2EvidenceMatch[1]);const evidence=this.repo.latestV2Evidence(runId);if(!evidence)throw new HttpError(404,"v2 evidence not found");sendJson(res,200,evidence);return true; }
    const shareCreateMatch=pathname.match(/^\/api\/v2\/verification-runs\/([^/]+)\/share-reports$/);
    if(shareCreateMatch&&method==="POST") { const run=this.repo.getV2Run(decodeURIComponent(shareCreateMatch[1]));if(!run||run.status!=="completed"||!isCurrentScoredRun(run))throw new HttpError(409,"completed scored run required");const endpointBindings=publicEndpointBindings(this.repo.v2Endpoints(run.id),run.id);const report={generatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+7*86400000).toISOString(),runId:run.id,mode:run.mode,identity:run.identity,protocolComparability:run.protocolComparability,referenceLevel:run.referenceLevel,endpointBindings,result:run.result,scopeNotice:"Point-in-time behavioral evidence; not vendor certification, identity probability, or future guarantee."};const reportHash=createHash("sha256").update(JSON.stringify(report)).digest("hex");sendJson(res,201,this.repo.createShareReport(run.id,report,reportHash,report.expiresAt));return true; }
    const shareMatch=pathname.match(/^\/api\/v2\/share-reports\/([^/]+)$/);
    if(shareMatch&&method==="GET") { const report=this.repo.getShareReport(decodeURIComponent(shareMatch[1]));if(!report)throw new HttpError(404,"share report not found");const bindings=Array.isArray(report.report?.endpointBindings)?report.report.endpointBindings:[];const currentEndpoints=this.repo.v2Endpoints(report.runId);const configurationChanged=bindings.some((binding:any)=>{const endpoint=currentEndpoints.find((value)=>value.role===binding.role);const provider=endpoint?.providerId?this.repo.getProvider(endpoint.providerId):undefined;if(!provider)return true;return this.reportBindings.config(provider,binding.model,binding.protocol).configRevision!==binding.configRevision;});sendJson(res,200,{...report,expired:Date.parse(report.expiresAt)<=Date.now(),revoked:Boolean(report.revokedAt),configurationChanged});return true; }
    if(shareMatch&&method==="DELETE") { this.repo.revokeShareReport(decodeURIComponent(shareMatch[1]));sendJson(res,200,{ok:true});return true; }
    const v2ExportMatch=pathname.match(/^\/api\/v2\/verification-runs\/([^/]+)\/export$/);
    if(v2ExportMatch&&method==="GET") { const run=this.repo.getV2Run(decodeURIComponent(v2ExportMatch[1]));if(!run||!isCurrentScoredRun(run))throw new HttpError(404,"scored run not found");const requested=new URL(req.url??"/","http://localhost").searchParams.get("format")??"json";return sendV2Export(res,run,this.repo.v2Endpoints(run.id),requested); }
    const v2ObservationMatch=pathname.match(/^\/api\/v2\/verification-runs\/([^/]+)\/observations$/);
    if(v2ObservationMatch&&method==="GET") { const runId=decodeURIComponent(v2ObservationMatch[1]);if(!this.repo.getV2Run(runId))throw new HttpError(404,"v2 run not found");sendJson(res,200,{items:this.repo.v2Observations(runId)});return true; }
    const v2CancelMatch=pathname.match(/^\/api\/v2\/verification-runs\/([^/]+)\/cancel$/);
    if(v2CancelMatch&&method==="POST") { sendJson(res,200,await this.v2Runs.cancel(decodeURIComponent(v2CancelMatch[1])));return true; }
    const v2RunMatch=pathname.match(/^\/api\/v2\/verification-runs\/([^/]+)$/);
    if(v2RunMatch&&method==="GET") { const run=this.repo.getV2Run(decodeURIComponent(v2RunMatch[1]));if(!run||!isCurrentScoredRun(run))throw new HttpError(404,"scored run not found");sendJson(res,200,run);return true; }
    if(v2RunMatch&&method==="DELETE") { const result=this.repo.deleteV2Run(decodeURIComponent(v2RunMatch[1]));if(!result.deleted)throw new HttpError(result.reason==="not_found"?404:409,result.reason==="active"?"active v2 run cannot be deleted":"v2 run not found");sendJson(res,200,{ok:true});return true; }
    if(pathname==="/api/enroll" && method==="POST" && legacyWritesRetired(req)) { throw new HttpError(410,"legacy enrollment is retired; use v2 references"); }
    if(pathname==="/api/audits" && method==="POST" && legacyWritesRetired(req)) { throw new HttpError(410,"legacy audit is retired; use v2 verification"); }
    if(pathname==="/api/enroll" && method==="POST") { await this.requireWritable(); if(this.connectionTests.active())throw new HttpError(409,"a connection test is active"); if(this.repo.activeRunCount())throw new HttpError(409,"another run is already active"); const input=await body(req); const selected=profile(input.profile??"enroll"); if(selected!=="enroll"&&selected!=="full")throw new HttpError(400,"enrollment profile must be enroll or full"); const providerId=id(input.providerId,"providerId"); const provider=this.repo.getProvider(providerId); if(!provider)throw new HttpError(404,"provider not found"); if(provider.role==="audit")throw new HttpError(400,"provider is not trusted for enrollment"); const model=string(input.model,"model",300); if(!provider.models.includes(model))throw new HttpError(400,"model is not configured for provider"); const run=this.repo.createRun({kind:"enroll",providerId,model,profile:selected}); this.runs.launch(run.id); sendJson(res,202,run); return true; }
    if(pathname==="/api/audits" && method==="POST") { await this.requireWritable(); if(this.connectionTests.active())throw new HttpError(409,"a connection test is active"); if(this.repo.activeRunCount())throw new HttpError(409,"another run is already active"); const input=await body(req); const selected=profile(input.profile??"audit"); if(selected!=="quick"&&selected!=="audit"&&selected!=="full")throw new HttpError(400,"audit profile must be quick, audit, or full"); const providerId=id(input.providerId,"providerId"); const provider=this.repo.getProvider(providerId); if(!provider)throw new HttpError(404,"provider not found"); if(provider.role==="reference")throw new HttpError(400,"provider is not configured for audit"); const model=string(input.model,"model",300); if(!provider.models.includes(model))throw new HttpError(400,"model is not configured for provider"); const referenceId=id(input.referenceId,"referenceId"); if(!this.repo.getReference(referenceId)&&!getBuiltinReference(referenceId))throw new HttpError(404,"reference fingerprint not found"); const run=this.repo.createRun({kind:"audit",providerId,model,claimedModel:string(input.claimedModel??input.model,"claimedModel",300),referenceId,profile:selected}); this.runs.launch(run.id); sendJson(res,202,run); return true; }
    if(pathname==="/api/runs" && method==="GET") { sendJson(res,200,{items:this.repo.listRuns().map((run)=>({...run,frameworkVersion:"legacy-v1",legacyUncalibrated:true}))}); return true; }
    if(pathname==="/api/runs/delete" && method==="POST") {
      const input=await body(req);
      if(!Array.isArray(input.ids) || !input.ids.length || input.ids.length>500) throw new HttpError(400,"invalid ids");
      const ids=input.ids.map((value:unknown,index:number)=>string(value,`ids[${index}]`,100));
      const result=this.repo.deleteRuns(ids);
      sendJson(res,200,{ok:true,...result,deletedCount:result.deleted.length,skippedCount:result.skipped.length});
      return true;
    }
    const exportMatch=pathname.match(/^\/api\/runs\/([^/]+)\/export$/);
    if(exportMatch && method==="GET") { const run=this.repo.getRun(decodeURIComponent(exportMatch[1])); if(!run)throw new HttpError(404,"run not found"); const requested=new URL(req.url??"/", "http://localhost").searchParams.get("format")??"json"; return sendExport(res,run,requested); }
    const runMatch=pathname.match(/^\/api\/runs\/([^/]+)$/);
    if(runMatch && method==="GET") { const run=this.repo.getRun(decodeURIComponent(runMatch[1])); if(!run)throw new HttpError(404,"run not found"); sendJson(res,200,run); return true; }
    if(runMatch && method==="DELETE") {
      const runId=decodeURIComponent(runMatch[1]);
      const result=this.repo.deleteRun(runId);
      if(!result.deleted) {
        if(result.reason==="not_found") throw new HttpError(404,"run not found");
        throw new HttpError(409,"active runs cannot be deleted; cancel first");
      }
      sendJson(res,200,{ok:true,deleted:[runId],deletedCount:1,skipped:[],skippedCount:0});
      return true;
    }
    const cancelMatch=pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if(cancelMatch && method==="POST") { sendJson(res,200,await this.runs.cancel(decodeURIComponent(cancelMatch[1]))); return true; }
    if(pathname==="/api/settings" && method==="GET") { sendJson(res,200,this.repo.settings()); return true; }
    if(pathname==="/api/settings" && method==="PUT") { const input=await body(req); const settings:SettingsRecord={concurrency:integer(input.concurrency,1,8,"concurrency"),tauMatch:number(input.tauMatch,0,1,"tauMatch"),tauMid:number(input.tauMid,0,1,"tauMid"),retainRaw:Boolean(input.retainRaw)}; if(settings.tauMid<=settings.tauMatch)throw new HttpError(400,"tauMid must be greater than tauMatch"); sendJson(res,200,this.repo.saveSettings(settings)); return true; }
    throw new HttpError(404,"not found");
  }
  private async publicProvider(provider:ProviderRecord) { const secret=await this.secrets.get(provider.secretRef).catch(()=>null); const {secretRef,...safe}=provider; return {...safe,keyMasked:maskSecret(secret),secretBackend:provider.secretRef.split(":",1)[0]}; }
}

function isCurrentScoredRun(run:any):boolean { const policy=run?.result?.scorecard?.policyVersion;return run?.mode==="reference_enrollment"||["queued","running","failed","cancelled"].includes(run?.status)||policy==="pamela-scorecard@3.0.0"||policy===V3_SCORING_POLICY_VERSION; }
function legacyWritesRetired(req:IncomingMessage):boolean { if(process.env.MODEL_VERITY_V2_EXPLORATORY_DEFAULT!=="1")return false;if(process.env.MODEL_VERITY_LEGACY_RESEARCH_MODE!=="1")return true;const remote=req.socket.remoteAddress??"";return !["127.0.0.1","::1","::ffff:127.0.0.1"].includes(remote); }
function protocol(value:unknown):AdapterId { if(value!=="openai-compatible"&&value!=="openai-responses"&&value!=="anthropic-messages")throw new HttpError(400,"invalid protocol"); return value; }
function role(value:unknown):"reference"|"audit"|"either" { if(value!=="reference"&&value!=="audit"&&value!=="either")throw new HttpError(400,"invalid role"); return value; }
function surface(value:unknown):"api"|"chatgpt"|"codex"|"enterprise"|"unknown" { if(!["api","chatgpt","codex","enterprise","unknown"].includes(String(value)))throw new HttpError(400,"invalid surface");return value as any; }
function sameComparableIdentity(left:any,right:any):boolean { const same=(a:unknown,b:unknown)=>typeof a==="string"&&typeof b==="string"&&Boolean(a.trim())&&a.trim().toLocaleLowerCase("und")===b.trim().toLocaleLowerCase("und");return same(left?.vendor,right?.vendor)&&same(left?.product,right?.product)&&typeof left?.surface==="string"&&left.surface!=="unknown"&&left.surface===right?.surface; }
function referenceCohortStatus(value:unknown):string { if(!["active","archived","review_required","quarantined"].includes(String(value)))throw new HttpError(400,"invalid reference cohort status");return String(value); }
function governanceEvent(value:unknown):string { const event=string(value,"eventType",100);if(!["confirmed","marked_stale","review_required","quarantined","superseded","archived","note"].includes(event))throw new HttpError(400,"invalid governance event");return event; }
function referenceFreshness(value:unknown):string { if(!["current","usable","stale"].includes(String(value)))throw new HttpError(400,"invalid freshness status");return String(value); }
function referenceQuality(value:unknown):string { if(!["approved","review_required","quarantined","superseded"].includes(String(value)))throw new HttpError(400,"invalid quality status");return String(value); }
function isoDate(value:unknown,name:string):string { const raw=string(value,name,100);if(!Number.isFinite(Date.parse(raw)))throw new HttpError(400,`invalid ${name}`);return new Date(raw).toISOString(); }
function sha256(value:unknown,name:string):string { const raw=string(value,name,64);if(!/^[a-f0-9]{64}$/i.test(raw))throw new HttpError(400,`invalid ${name}`);return raw.toLowerCase(); }
function models(value:unknown):string[] { if(!Array.isArray(value)||!value.length||value.length>1000)throw new HttpError(400,"invalid models"); return [...new Set(value.map((v)=>string(v,"model",300)))]; }
function redactError(message:string,secrets:string[]=[]):string { let safe=message; for(const secret of secrets.filter(Boolean))safe=safe.split(secret).join("[redacted]"); return safe.replace(/Bearer\s+[^\s"']+/gi,"Bearer [redacted]").replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._-]{8,}\b/gi,"[redacted]").slice(0,500); }
function integer(value:unknown,min:number,max:number,name:string):number { const n=Number(value); if(!Number.isSafeInteger(n)||n<min||n>max)throw new HttpError(400,`invalid ${name}`); return n; }
function number(value:unknown,min:number,max:number,name:string):number { const n=Number(value); if(!Number.isFinite(n)||n<min||n>max)throw new HttpError(400,`invalid ${name}`); return n; }
function publicReference(ref:any){ const {fingerprint,...safe}=ref; return {...safe,sourceType:ref.sourceType??"local-enrollment",readonly:Boolean(ref.readonly),cellCoverage:`${ref.cellIds.length}/40`}; }
function publicBuiltinReference(ref:any){return{...publicReference(ref),level:"L3",identity:{vendor:ref.modelClaimed.split('/')[0]??"unknown",product:ref.modelClaimed,surface:"unknown"},freshnessStatus:referenceFreshnessAt(ref.enrolledAt),qualityStatus:"approved"};}
function publicVersionReference(repo:Repository,version:any){const cohort=version.cohortId?repo.getReferenceCohortV2(version.cohortId):undefined;const cellIds=Object.keys(version.fingerprint?.cells??{});return{id:version.id,providerId:version.identity?.providerId??"",modelClaimed:version.identity?.product??version.identity?.model??cohort?.product??"unknown",label:cohort?.label??version.identity?.product??version.id,baseUrl:"",enrolledAt:version.collectedAt,batteryVersion:"pamela-challenge@2",normalizeVersion:"pamela@1",systemPromptVersion:"pamela@1",cellIds,cellCoverage:`${cellIds.length}/40`,sourceType:"self-built-reference",readonly:true,trustNotice:"用户信任路径的版本化行为样本；不是厂商认证或来源证明。",level:version.level,identity:version.identity,freshnessStatus:version.freshnessStatus,qualityStatus:version.qualityStatus,protocol:version.protocol,cohortId:version.cohortId};}
function sendV2Export(res:ServerResponse,run:any,endpoints:any[],format:string):true {
  const notice="Point-in-time behavioral evidence; not vendor certification, identity probability, or future guarantee.";
  const safeEndpoints=publicEndpointBindings(endpoints,run.id);
  const report={reportType:run.mode,generatedAt:new Date().toISOString(),run:{...run,budget:{...run.budget,targetCredentialSessionId:undefined,referenceCredentialSessionId:undefined}},endpointBindings:safeEndpoints,scopeNotice:notice};
  let content:string,type:string,extension:string;
  if(format==="json"){content=`${JSON.stringify(report,null,2)}\n`;type="application/json; charset=utf-8";extension="json";}
  else if(format==="markdown"||format==="md"){const conclusion=run.result?.conclusion,scorecard=run.result?.scorecard;content=`# model-verity 验证报告\n\n- Run: \`${md(run.id)}\`\n- Mode: ${md(run.mode)}\n- Status: ${md(run.status)}\n- Model: ${md(run.model)}\n- ${md(scorecard?.displayScoreLabel??"综合可信评分")}: ${md(scorecard?.displayScore??scorecard?.score??"无法评分")} / 100\n- 综合证据分: ${md(scorecard?.score??"无法评分")} / 100\n- 可信度结论: ${md(scorecard?.label??"无法评分")}\n- 证据范围: ${md(scorecard?.scopeLabel??"无额外范围标签")}\n- 评分规则: ${md(scorecard?.policyVersion??"n/a")}\n- Protocol comparability: ${md(run.protocolComparability)}\n- Reference level: ${md(run.referenceLevel)}\n- Created: ${md(run.createdAt)}\n\n## 评分维度\n\n${(scorecard?.dimensions??[]).map((value:any)=>`- **${md(value.label)}**：${md(value.score)} / 100（权重 ${md(value.weight)}%）— ${md(value.detail)}`).join("\n")||"- 无法评分"}\n\n${(scorecard?.caps??[]).length?`## 结论限制\n\n${scorecard.caps.map((value:string)=>`- ${md(value)}`).join("\n")}\n\n`:""}## 五维证据\n\n${["behavior","provenance","stability","comparability","freshness"].map((key)=>`- **${key}**：${md(conclusion?.[key]?.label??"数据不足")} — ${md(conclusion?.[key]?.detail??"未形成证据")}`).join("\n")}\n\n## Endpoint bindings\n\n${safeEndpoints.map((value)=>`- ${md(value.role)}：endpoint hash \`${md(value.endpointHash)}\`，config revision \`${md(value.configRevision)}\`，credential scope HMAC \`${md(value.credentialScopeHmac)}\``).join("\n")||"- 未形成"}\n\n## 预算与质量\n\n- Requests: ${md(run.result?.manifest?.requestsUsed??0)} / ${md(run.result?.manifest?.maxRequests??run.budget?.maxEndpointRequests)}\n- Start gap p95: ${md(run.result?.manifest?.startGapP95Ms??"n/a")} ms\n- Raw JSD: ${md(run.result?.distance?.score??"n/a")}\n\n> ${notice}\n`;type="text/markdown; charset=utf-8";extension="md";}
  else if(format==="csv"){const rows=["run_id,status,mode,model,display_score,display_score_label,trust_score,trust_label,trust_scope,scoring_policy,score_caps,protocol_comparability,reference_level,behavior,provenance,stability,comparability,freshness,requests_used,max_requests,start_gap_p95_ms,endpoint_bindings,created_at,scope_notice",[run.id,run.status,run.mode,run.model,run.result?.scorecard?.displayScore??run.result?.scorecard?.score,run.result?.scorecard?.displayScoreLabel??"综合可信评分",run.result?.scorecard?.score,run.result?.scorecard?.label,run.result?.scorecard?.scopeLabel,run.result?.scorecard?.policyVersion,JSON.stringify(run.result?.scorecard?.caps??[]),run.protocolComparability,run.referenceLevel,run.result?.conclusion?.behavior?.label,run.result?.conclusion?.provenance?.label,run.result?.conclusion?.stability?.label,run.result?.conclusion?.comparability?.label,run.result?.conclusion?.freshness?.label,run.result?.manifest?.requestsUsed,run.result?.manifest?.maxRequests??run.budget?.maxEndpointRequests,run.result?.manifest?.startGapP95Ms,JSON.stringify(safeEndpoints),run.createdAt,notice].map(csv).join(",")];content=`${rows.join("\n")}\n`;type="text/csv; charset=utf-8";extension="csv";}
  else throw new HttpError(400,"unsupported export format");
  res.writeHead(200,{"content-type":type,"content-disposition":`attachment; filename=\"model-verity-v2-${run.id}.${extension}\"`,"content-length":Buffer.byteLength(content),"cache-control":"no-store","x-content-type-options":"nosniff"});res.end(content);return true;
}
function publicEndpointBindings(endpoints:any[],runId:string):any[] { return endpoints.map(({credentialScopeHash,endpointDisplay,providerId,...value})=>({...value,credentialScopeHmac:createHash("sha256").update(`${runId}:${credentialScopeHash}`).digest("hex")})); }
function csv(value:any):string { let text=String(value??"");if(/^[=+\-@]/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`; }
function md(value:any):string { return String(value??"").replace(/[\\`*_{}[\]()#+.!|>-]/g,"\\$&"); }
function sendExport(res:ServerResponse,run:any,format:string):true {
  const safe={id:run.id,kind:run.kind,status:run.status,providerId:run.providerId,model:run.model,claimedModel:run.claimedModel,referenceId:run.referenceId,profile:run.profile,createdAt:run.createdAt,startedAt:run.startedAt,finishedAt:run.finishedAt,result:run.result,error:run.error};
  let content:string; let type:string; let extension:string;
  if(format==="json"){content=`${JSON.stringify(safe,null,2)}\n`;type="application/json; charset=utf-8";extension="json";}
  else if(format==="markdown"||format==="md"){const r=run.result??{};const included=(r.cells??[]).map((cell:any)=>`- \`${cell.cellId}\`: JSD ${cell.jsd}, ref ${cell.nRef}, audit ${cell.nAudit}`).join("\n")||"- n/a";const excluded=(r.excludedCells??[]).map((cell:any)=>`- \`${cell.cellId}\`: ${cell.reason}, ref ${cell.nRef??"n/a"}, audit ${cell.nAudit??"n/a"}, minimum ${cell.minValid}`).join("\n")||"- none";content=`# model-verity report\n\n- Run: \`${run.id}\`\n- Status: **${run.status}**\n- Type: ${run.kind}\n- Provider: ${r.run?.providerName??"n/a"}\n- Endpoint: ${r.run?.endpoint??"n/a"}\n- Model: ${run.model}\n- Claimed: ${run.claimedModel??run.model}\n- Profile: ${run.profile}\n- Created: ${run.createdAt}\n- Verdict: ${r.trust??"n/a"}\n- Verdict reason: ${r.verdictReason??"legacy record: unavailable"}\n- Score: ${r.score??"n/a"}\n- Thresholds: ${JSON.stringify(r.thresholds??{})}\n- Decision snapshot: ${JSON.stringify(r.decision??{})}\n- Success rate: ${r.reliability?.successRate??"n/a"}\n- Counts: ${JSON.stringify(r.reliability?.counts??{})}\n- p50 latency: ${r.reliability?.p50ms??"n/a"} ms\n- p95 latency: ${r.reliability?.p95ms??"n/a"} ms\n- Errors: ${JSON.stringify(r.reliability?.errorClasses??{})}\n- Response model weak signal: ${JSON.stringify(r.responseModelCounts??{})}\n- Protocol: ${r.protocolNote??"n/a"}\n\n## Included cells\n${included}\n\n## Excluded cells\n${excluded}\n\n> Relative behavioral evidence; not vendor attestation or cryptographic proof. Excluded cells mean insufficient evidence, not behavioral mismatch.\n`;type="text/markdown; charset=utf-8";extension="md";}
  else if(format==="csv"){const r=run.result??{};const quote=(v:any)=>{let text=String(v??"");if(/^[=+\-@]/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;};content=`run_id,status,kind,provider,endpoint,model,claimed_model,profile,verdict,verdict_reason,score,tau_match,tau_mid,success_rate,planned,succeeded,failed,valid,invalid,refusal,empty,p50_ms,p95_ms,error_classes,response_models,included_cells,excluded_cells,created_at\n${[run.id,run.status,run.kind,r.run?.providerName,r.run?.endpoint,run.model,run.claimedModel??run.model,run.profile,r.trust,r.verdictReason,r.score,r.thresholds?.match,r.thresholds?.mid,r.reliability?.successRate,r.reliability?.counts?.planned,r.reliability?.counts?.succeeded,r.reliability?.counts?.failed,r.reliability?.counts?.valid,r.reliability?.counts?.invalid,r.reliability?.counts?.refusal,r.reliability?.counts?.empty,r.reliability?.p50ms,r.reliability?.p95ms,JSON.stringify(r.reliability?.errorClasses??{}),JSON.stringify(r.responseModelCounts??{}),JSON.stringify(r.cells??[]),JSON.stringify(r.excludedCells??[]),run.createdAt].map(quote).join(",")}\n`;type="text/csv; charset=utf-8";extension="csv";}
  else throw new HttpError(400,"unsupported export format");
  res.writeHead(200,{"content-type":type,"content-disposition":`attachment; filename=\"model-verity-${run.id}.${extension}\"`,"content-length":Buffer.byteLength(content),"cache-control":"no-store"});res.end(content);return true;
}

export type ApiProtocol = "openai-compatible" | "openai-responses" | "anthropic-messages";

export interface ApiProvider {
  id: string;
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  models: string[];
  role: "reference" | "audit" | "either";
  headers: Record<string, string>;
  keyMasked: string;
  secretBackend: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiReference {
  id: string;
  providerId: string;
  modelClaimed: string;
  label: string;
  baseUrl: string;
  enrolledAt: string;
  cellIds: string[];
  cellCoverage: string;
  sourceType: "builtin-research" | "local-enrollment" | "self-built-reference";
  readonly: boolean;
  level?: "L1" | "L2" | "L3";
  freshnessStatus?: "current" | "usable" | "stale";
  qualityStatus?: "approved" | "review_required" | "quarantined" | "superseded";
  protocol?: ApiProtocol;
  identity?: any;
  cohortId?: string;
  trustNotice?: string;
  datasetDoi?: string;
  license?: string;
}

export interface ApiRun {
  id: string;
  kind: "enroll" | "audit";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  providerId: string;
  model: string;
  claimedModel?: string;
  referenceId?: string;
  profile: "quick" | "audit" | "full" | "enroll";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: number;
  successCount: number;
  failCount: number;
  result?: any;
  error?: string;
  frameworkVersion?: string;
  legacyUncalibrated?: boolean;
}

export interface ApiStatus {
  maintenance: boolean;
  activeRun: boolean;
  activeConnectionTest: ApiConnectionTest | null;
}

export interface ApiConnectionTestResult {
  ok: boolean;
  category: "success" | "auth" | "rate_limit" | "timeout" | "network" | "server" | "invalid_response" | "cancelled" | "other";
  httpStatus?: number;
  retryAfterMs?: number;
  latencyMs?: number;
  responseModel?: string;
  reasoningDisabled?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
  message: string;
  advice: string;
}

export interface ApiConnectionTest {
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  protocol: ApiProtocol;
  configuredAt: string;
  createdAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  result?: ApiConnectionTestResult;
}

export interface ApiZenodoUpdateJob {
  id: string;
  kind: "prepare";
  status: "queued" | "running" | "done" | "failed" | "canceled";
  stage: string;
  progress: number;
  message: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ApiZenodoCatalogModel { model: string; qualified: boolean; nValid: number; missingCells: number; belowMinimumCells: number }

export interface ApiZenodoUpdateStatus {
  current: { libraryVersion: string; models: number; collectedAt: string; source: "bundled" | "runtime"; recordId?: string };
  latest: { recordId: string; version?: string; updated: string } | null;
  updateAvailable: boolean;
  catalog: { recordId?: string; ready: boolean; builtAt?: string; models: ApiZenodoCatalogModel[]; total: number; qualified: number };
  prepareJob: ApiZenodoUpdateJob | null;
  checkedAt?: string;
  lastError?: string;
  cacheBytes: number;
  versions: { file: string; appliedAt: string; libraryVersion: string; modelIds: number }[];
}

export interface ApiV2Run {
  id: string;
  mode: "screening" | "paired" | "reference_enrollment";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  providerId: string;
  referenceProviderId?: string;
  referenceId?: string;
  model: string;
  referenceModel?: string;
  profile: "quick" | "audit" | "full";
  protocolComparability: "P1" | "P2" | "P3";
  referenceLevel: "L1" | "L2" | "L3";
  identity: any;
  budget: any;
  progress: number;
  successCount: number;
  failCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: any;
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
      signal: controller.signal,
    });
  } catch (cause) {
    if (controller.signal.aborted) throw new Error("请求超时，请检查网络后重试。");
    throw cause;
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload as T;
}

export const api = {
  bootstrap: async () => request<{ providers: ApiProvider[]; references: ApiReference[]; runs: ApiV2Run[]; status: ApiStatus }>("/api/bootstrap"),
  saveProvider: (value: Record<string, unknown>) => request<ApiProvider>("/api/providers", { method: "POST", body: JSON.stringify(value) }),
  discoverModels: async (value: { providerId?: string; protocol: string; baseUrl: string; apiKey?: string }) =>
    (await request<{ items: string[] }>("/api/providers/models", { method: "POST", body: JSON.stringify(value) })).items,
  providerUsage: (id: string) => request<{ references: number; activeRuns: number; historyRuns: number }>(`/api/providers/${encodeURIComponent(id)}/usage`),
  deleteProvider: (id: string) => request<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  startConnectionTest: (providerId: string, model: string, protocol: ApiProtocol) => request<ApiConnectionTest>(`/api/providers/${encodeURIComponent(providerId)}/connection-tests`, { method: "POST", body: JSON.stringify({ model, protocol }) }),
  connectionTest: (id: string) => request<ApiConnectionTest>(`/api/connection-tests/${encodeURIComponent(id)}`),
  cancelConnectionTest: (id: string) => request<ApiConnectionTest>(`/api/connection-tests/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  referenceUsage: (id: string) => request<{ activeRuns: number; historyRuns: number }>(`/api/references/${encodeURIComponent(id)}/usage`),
  deleteReference: (id: string) => request<{ ok: boolean }>(`/api/references/${encodeURIComponent(id)}`, { method: "DELETE" }),
  run: (id: string) => request<ApiRun>(`/api/runs/${encodeURIComponent(id)}`),
  deleteRun: (id: string) => request<{ ok: boolean }>(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteRuns: (ids: string[]) => request<{ ok: boolean; deleted: string[]; skipped: { id: string; reason: string }[] }>("/api/runs/delete", { method: "POST", body: JSON.stringify({ ids }) }),
  enroll: (value: { providerId: string; model: string; profile: string }) => request<ApiRun>("/api/enroll", { method: "POST", body: JSON.stringify(value) }),
  audit: (value: { providerId: string; model: string; claimedModel: string; referenceId: string; profile: string }) => request<ApiRun>("/api/audits", { method: "POST", body: JSON.stringify(value) }),
  cancel: (id: string) => request<ApiRun>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  exportUrl: (id: string, format: "json" | "markdown" | "csv") => `/api/runs/${encodeURIComponent(id)}/export?format=${format}`,
  v2Run: (id: string) => request<ApiV2Run>(`/api/v2/verification-runs/${encodeURIComponent(id)}`),
  deleteV2Run: (id:string) => request<{ok:boolean}>(`/api/v2/verification-runs/${encodeURIComponent(id)}`,{method:"DELETE"}),
  v2ExportUrl: (id:string,format:"json"|"markdown"|"csv")=>`/api/v2/verification-runs/${encodeURIComponent(id)}/export?format=${format}`,
  createV2ShareReport: (id:string)=>request<any>(`/api/v2/verification-runs/${encodeURIComponent(id)}/share-reports`,{method:"POST",body:"{}"}),
  referenceCohortsV2: async()=> (await request<{items:any[]}>("/api/v2/reference-cohorts")).items,
  referenceVersionsV2: async(cohortId?:string)=> (await request<{items:any[]}>(`/api/v2/reference-versions${cohortId?`?cohortId=${encodeURIComponent(cohortId)}`:""}`)).items,
  createReferenceCohortV2:(value:Record<string,unknown>)=>request<any>("/api/v2/reference-cohorts",{method:"POST",body:JSON.stringify(value)}),
  createReferenceVersionV2:(value:Record<string,unknown>)=>request<any>("/api/v2/reference-versions",{method:"POST",body:JSON.stringify(value)}),
  addReferenceGovernanceEvent: (id:string,value:Record<string,unknown>)=>request<{eventType:string;version:any}>(`/api/v2/reference-versions/${encodeURIComponent(id)}/governance-events`,{method:"POST",body:JSON.stringify(value)}),
  startReferenceEnrollment: (value:Record<string,unknown>)=>request<ApiV2Run>("/api/v2/references/enrollment-plans",{method:"POST",body:JSON.stringify(value)}),
  createBudgetAuthorization: (value: Record<string,unknown>) => request<any>("/api/v2/budget-authorizations", { method:"POST", body:JSON.stringify(value) }),
  startV2Run: (value: Record<string, unknown>) => request<ApiV2Run>("/api/v2/verification-runs", { method: "POST", body: JSON.stringify(value) }),
  cancelV2Run: (id: string) => request<ApiV2Run>(`/api/v2/verification-runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  createCredentialSession: (endpointRole:"reference"|"target",apiKey:string)=>request<any>("/api/v2/credential-sessions",{method:"POST",body:JSON.stringify({endpointRole,apiKey,ttlMinutes:15})}),
  builtinLibraryUpdateStatus: () => request<ApiZenodoUpdateStatus>("/api/v2/references/update/status"),
  builtinLibraryUpdateCheck: (refresh: boolean) => request<ApiZenodoUpdateStatus>("/api/v2/references/update/check", { method: "POST", body: JSON.stringify({ refresh }) }),
  builtinLibraryUpdatePrepare: () => request<ApiZenodoUpdateJob>("/api/v2/references/update/prepare", { method: "POST", body: "{}" }),
  builtinLibraryUpdateJob: (id: string) => request<ApiZenodoUpdateJob>(`/api/v2/references/update/jobs/${encodeURIComponent(id)}`),
  builtinLibraryUpdateCancelJob: (id: string) => request<ApiZenodoUpdateStatus>(`/api/v2/references/update/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  builtinLibraryUpdateApply: (modelIds: string[]) => request<ApiZenodoUpdateStatus>("/api/v2/references/update", { method: "POST", body: JSON.stringify({ modelIds }) }),
  builtinLibraryUpdateRollback: () => request<ApiZenodoUpdateStatus>("/api/v2/references/update/rollback", { method: "POST", body: "{}" }),
  builtinLibraryUpdateCleanCache: () => request<{ ok: boolean; freedBytes: number }>("/api/v2/references/update/cache/clean", { method: "POST", body: "{}" }),
};

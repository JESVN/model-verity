/** Shared view models — preview fixtures and future app logic must agree. */

export type TrustLevel =
  | "likely_match"
  | "inconclusive"
  | "likely_mismatch"
  | "failed";

export type VerifyProfile = "quick" | "audit" | "full";

export type CanvasPhase = "setup" | "running" | "result";

export interface ProviderOption {
  id: string;
  name: string;
  baseUrl: string;
  protocol: "openai-compatible" | "openai-responses" | "anthropic-messages";
  role: "reference" | "audit" | "either";
  models: string[];
  keyMasked: string;
}

export interface ReferenceOption {
  id: string;
  label: string;
  modelClaimed: string;
  sourceBaseUrl: string;
  enrolledAt: string;
  cellCoverage: string;
  sourceType?: "builtin-research" | "local-enrollment" | "self-built-reference";
  readonly?: boolean;
  trustNotice?: string;
  datasetDoi?: string;
  license?: string;
  verdictReason?: string;
  scoreWouldMatch?: boolean;
}

export interface SetupView {
  providers: ProviderOption[];
  references: ReferenceOption[];
  selectedProviderId: string | null;
  selectedModel: string | null;
  claimedModel: string;
  selectedReferenceId: string | null;
  profile: VerifyProfile;
  estimatedRequests: number;
  estimatedMinutes: number;
  canStart: boolean;
  disabledReason?: string;
}

export interface RunningView {
  profile: VerifyProfile;
  progress: number; // 0–1
  phaseLabel: string;
  cellCurrent: number;
  cellTotal: number;
  elapsedLabel: string;
  successCount: number;
  failCount: number;
  detailLines?: string[];
}

export interface SampleCounts {
  planned: number;
  succeeded: number;
  failed: number;
  valid: number;
  invalid: number;
  refusal: number;
  empty: number;
  error: number;
}

export interface ReliabilityView {
  successRate: number; // 0–1
  p50ms?: number;
  p95ms: number;
  invalidRate: number; // 0–1
  errorClasses?: Record<string, number>;
  counts?: SampleCounts;
}

export interface CellEvidence {
  cellId: string;
  label: string;
  jsd: number;
  nValid: number;
  nRef?: number;
  originalId?: string;
}

export interface ExcludedCellEvidence {
  cellId: string;
  label: string;
  reason: string;
  nRef?: number;
  nAudit?: number;
  minValid: number;
}

export interface EvidenceCheck {
  status: "pass" | "warn" | "fail";
  label: string;
  detail: string;
}

export interface VerificationResultView {
  trust: TrustLevel;
  headline: string;
  score?: number;
  thresholds?: { match: number; mid: number };
  reference: {
    label: string;
    enrolledAt: string;
    sourceType?: "builtin-research" | "local-enrollment" | "self-built-reference";
    datasetDoi?: string;
    license?: string;
    trustNotice?: string;
  };
  reliability: ReliabilityView;
  profile: VerifyProfile;
  cellsUsed: string;
  verdictReason?: string;
  reasons?: string[];
  qualityChecks?: EvidenceCheck[];
  recommendations?: string[];
  responseModelWeakSignal?: string;
  responseModelNote?: string;
  protocolNote?: string;
  runInfo?: {
    runId: string;
    providerName?: string;
    endpoint?: string;
    requestedModel: string;
    claimedModel: string;
    startedAt?: string;
    finishedAt?: string;
    elapsed?: string;
    plannedRequests?: number;
    completedRequests?: number;
    batteryVersion?: string;
    normalizeVersion?: string;
    systemPromptVersion?: string;
  };
  legacyEvidence?: boolean;
  cells?: CellEvidence[];
  excludedCells?: ExcludedCellEvidence[];
}

export interface HistoryRow {
  id: string;
  when: string;
  provider: string;
  model: string;
  trust: TrustLevel;
  score?: number;
}

export type NavId = "verify" | "providers" | "references" | "history";

export type PreviewSceneId =
  | "P01"
  | "P02"
  | "P03"
  | "P04"
  | "P05"
  | "P06"
  | "P07"
  | "P08"
  | "P09"
  | "P10"
  | "P11"
  | "P12";

import type { AdapterId } from "../adapters/types.js";

export const V2_FRAMEWORK_VERSION = "service-claims@3.0.0";
export const V2_CHALLENGE_VERSION = "pamela-challenge@2";
export const V2_POLICY_VERSION = "avoid-harm-1pct@1";

export type SurfaceIdentity = "api" | "chatgpt" | "codex" | "enterprise" | "unknown";
export type ReferenceLevel = "L1" | "L2" | "L3";
export type ProtocolComparability = "P1" | "P2" | "P3";
export type VerificationMode = "screening" | "paired" | "reference_enrollment";
export type V2RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ModelIdentity {
  vendor: string;
  product: string;
  surface: SurfaceIdentity;
  snapshot?: string;
}

export interface IdentityLayers {
  declared: ModelIdentity;
  observed?: Partial<ModelIdentity> & { requestedModel?: string; responseModels?: Record<string, number> };
  inferred?: Partial<ModelIdentity> & { confidence: "low" | "medium"; rule: string };
}

export interface V2EndpointInput {
  providerId?: string;
  name?: string;
  baseUrl?: string;
  protocol: AdapterId;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  identity: IdentityLayers;
  referenceLevel: ReferenceLevel;
}

export interface BudgetLimits {
  maxPairs: number;
  maxEndpointRequests: number;
  maxAttemptsPerEndpoint: number;
  expiresAt: string;
}

export interface ChallengeItem {
  challengeId: string;
  pairId: string;
  blockIndex: number;
  cellId: string;
  repetition: number;
  system: string;
  user: string;
  requestHash: string;
}

export interface ChallengeManifest {
  version: string;
  seed: string;
  createdAt: string;
  contentHash: string;
  concurrency: number;
  protocolComparability: ProtocolComparability;
  promptMode: "fixed" | "marked";
  items: ChallengeItem[];
}

export interface CalibrationArtifact {
  id: string;
  version: string;
  frameworkVersion: string;
  vendor: string;
  product: string;
  surface: SurfaceIdentity;
  protocols: AdapterId[];
  profile: string;
  cellIds: string[];
  sampleSize: number;
  genuineDistances: number[];
  impostorDistances: number[];
  supportMax: number;
  anomalyMin: number;
  falseAcceptRate: number;
  falseRejectRate: number;
  minCoverage: number;
  createdAt: string;
  source: string;
  manifestHash: string;
}

export interface DimensionConclusion {
  status: string;
  label: string;
  detail: string;
}

export interface V2Conclusion {
  frameworkVersion: string;
  policyVersion: string;
  behavior: DimensionConclusion;
  provenance: DimensionConclusion;
  stability: DimensionConclusion;
  comparability: DimensionConclusion;
  freshness: DimensionConclusion;
  summary: string;
  strongConclusion: boolean;
  calibrationId?: string;
  limitations: string[];
}

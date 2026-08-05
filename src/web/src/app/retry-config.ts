export type RetryProtocol = "openai-compatible" | "openai-responses" | "anthropic-messages";
export type RetryProfile = "quick" | "audit" | "full";

interface RetryProvider {
  id: string;
  role: "reference" | "audit" | "either";
  models: string[];
}

interface RetryReference {
  id: string;
}

interface RetryRun {
  mode: "screening" | "paired" | "reference_enrollment";
  providerId: string;
  referenceProviderId?: string;
  referenceId?: string;
  model: string;
  referenceModel?: string;
  profile: RetryProfile;
  identity?: {
    declared?: Record<string, unknown>;
    reference?: Record<string, unknown>;
    observed?: Record<string, unknown>;
  };
}

export interface RetryConfiguration {
  mode: "screening" | "paired";
  providerId?: string;
  model?: string;
  referenceId?: string;
  referenceProviderId?: string;
  referenceModel?: string;
  profile: RetryProfile;
  targetProtocol?: RetryProtocol;
  referenceProtocol?: RetryProtocol;
  vendor?: string;
  product?: string;
  surface?: string;
  referenceVendor?: string;
  referenceProduct?: string;
  referenceSurface?: string;
  omissions: string[];
}

const PROTOCOLS = new Set<RetryProtocol>(["openai-compatible", "openai-responses", "anthropic-messages"]);
const SURFACES = new Set(["api", "chatgpt", "codex", "enterprise", "unknown"]);
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function protocol(value: unknown): RetryProtocol | undefined { return PROTOCOLS.has(value as RetryProtocol) ? value as RetryProtocol : undefined; }
function surface(value: unknown): string | undefined { return SURFACES.has(String(value)) ? String(value) : undefined; }

export function buildRetryConfiguration(run: RetryRun, providers: RetryProvider[], references: RetryReference[]): RetryConfiguration {
  const mode = run.mode === "paired" ? "paired" : "screening";
  const target = providers.find((item) => item.id === run.providerId && item.role !== "reference");
  const referenceProvider = providers.find((item) => item.id === run.referenceProviderId && item.role !== "audit");
  const declared = run.identity?.declared ?? {};
  const reference = run.identity?.reference ?? {};
  const observed = run.identity?.observed ?? {};
  const omissions: string[] = [];

  if (!target) omissions.push("原目标供应商已删除或不再可用于验证");
  else if (!target.models.includes(run.model)) omissions.push("原目标模型已不在供应商配置中");

  if (mode === "screening" && (!run.referenceId || !references.some((item) => item.id === run.referenceId))) {
    omissions.push("原参考样本已删除或当前不可用");
  }
  if (mode === "paired") {
    if (!referenceProvider) omissions.push("原参考供应商已删除或不再可用");
    else if (!run.referenceModel || !referenceProvider.models.includes(run.referenceModel)) omissions.push("原参考模型已不在供应商配置中");
  }

  return {
    mode,
    providerId: target?.id,
    model: target?.models.includes(run.model) ? run.model : undefined,
    referenceId: mode === "screening" && run.referenceId && references.some((item) => item.id === run.referenceId) ? run.referenceId : undefined,
    referenceProviderId: mode === "paired" ? referenceProvider?.id : undefined,
    referenceModel: mode === "paired" && run.referenceModel && referenceProvider?.models.includes(run.referenceModel) ? run.referenceModel : undefined,
    profile: run.profile,
    targetProtocol: target ? protocol(observed.targetProtocol) : undefined,
    referenceProtocol: referenceProvider ? protocol(observed.referenceProtocol) : undefined,
    vendor: text(declared.vendor),
    product: text(declared.product),
    surface: surface(declared.surface),
    referenceVendor: text(reference.vendor),
    referenceProduct: text(reference.product),
    referenceSurface: surface(reference.surface),
    omissions,
  };
}

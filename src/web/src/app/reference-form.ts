export function generatedReferenceLabel(
  providerName: string,
  vendor: string,
  product: string,
  model: string,
  date = new Date(),
): string {
  const identity = [vendor.trim(), (product.trim() || model.trim())].filter(Boolean).join(" ");
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return [providerName.trim(), identity, month].filter(Boolean).join(" · ");
}

export function productAfterModelChange(
  currentProduct: string,
  nextModel: string,
  customized: boolean,
): string {
  return customized ? currentProduct : nextModel;
}

export function referenceModelOptions(configuredModels: string[], discoveredModels: string[]) {
  const configured = new Set(configuredModels);
  return [...new Set([...configuredModels, ...discoveredModels])].map((value) => {
    const available = configured.has(value);
    return {
      value,
      label: value,
      disabled: !available,
      badge: discoveredModels.includes(value) ? (available ? "已配置" : "未配置") : undefined,
      badgeTone: "neutral" as const,
      description: available ? undefined : "请先在供应商页把该模型加入配置，再创建参考样本。",
    };
  });
}

export type ReferenceGovernanceEventType = "confirmed" | "marked_stale" | "review_required" | "quarantined";
export type ReferenceGovernanceStatus = "current" | "usable" | "stale" | "review_required" | "quarantined" | "superseded";

interface ReferenceVersionStatus {
  freshnessStatus?: string;
  qualityStatus?: string;
}

export function referenceGovernanceStatus(version: ReferenceVersionStatus): ReferenceGovernanceStatus {
  if (version.qualityStatus === "superseded") return "superseded";
  if (version.qualityStatus === "quarantined") return "quarantined";
  if (version.qualityStatus === "review_required") return "review_required";
  if (version.freshnessStatus === "stale") return "stale";
  if (version.freshnessStatus === "usable") return "usable";
  return "current";
}

export function referenceVersionAfterGovernance<T extends ReferenceVersionStatus>(
  version: T,
  eventType: ReferenceGovernanceEventType,
): T {
  if (eventType === "confirmed") {
    return { ...version, freshnessStatus: "current", qualityStatus: "approved" };
  }
  if (eventType === "marked_stale") {
    return { ...version, freshnessStatus: "stale", qualityStatus: "approved" };
  }
  return { ...version, qualityStatus: eventType };
}

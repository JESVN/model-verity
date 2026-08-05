import type { TrustLevel } from "./types";

export interface TrustMeta {
  level: TrustLevel;
  shortLabel: string;
  tone: "high" | "mid" | "low" | "failed";
}

export function trustMeta(level: TrustLevel): TrustMeta {
  switch (level) {
    case "likely_match":
      return { level, shortLabel: "高可信", tone: "high" };
    case "inconclusive":
      return { level, shortLabel: "中等可信", tone: "mid" };
    case "likely_mismatch":
      return { level, shortLabel: "低可信", tone: "low" };
    case "failed":
      return { level, shortLabel: "无法完成", tone: "failed" };
  }
}

export function profileLabel(profile: "quick" | "audit" | "full"): string {
  switch (profile) {
    case "quick":
      return "Quick";
    case "audit":
      return "Audit";
    case "full":
      return "Full";
  }
}

export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

import { createHash } from "node:crypto";
import type { CalibrationArtifact } from "./types.js";

export function empiricalTailProbability(values: readonly number[], observed: number, side: "upper" | "lower" = "upper"): number {
  if (!values.length || !Number.isFinite(observed)) return 1;
  const extreme = values.filter((value) => side === "upper" ? value >= observed : value <= observed).length;
  return (extreme + 1) / (values.length + 1);
}

export function percentile(values: readonly number[], probability: number): number | undefined {
  if (!values.length || probability < 0 || probability > 1) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index];
}

export function bootstrapMeanInterval(values: readonly number[], options: { iterations?: number; alpha?: number; seed?: string } = {}): { low?: number; high?: number; mean?: number } {
  if (!values.length) return {};
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const random = seededRandom(options.seed ?? "model-verity-v2");
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    low: percentile(means, alpha / 2),
    high: percentile(means, 1 - alpha / 2),
  };
}

export function validateCalibrationArtifact(value: CalibrationArtifact): CalibrationArtifact {
  if (!value.id || !value.version || !value.frameworkVersion || !value.manifestHash) throw new Error("invalid calibration identity");
  if (!value.cellIds.length || value.sampleSize < 1) throw new Error("invalid calibration coverage");
  if (!value.genuineDistances.length || !value.impostorDistances.length) throw new Error("calibration requires genuine and impostor distributions");
  for (const distance of [...value.genuineDistances, ...value.impostorDistances, value.supportMax, value.anomalyMin]) {
    if (!Number.isFinite(distance) || distance < 0 || distance > 1) throw new Error("invalid calibration distance");
  }
  if (value.supportMax > value.anomalyMin) throw new Error("calibration review region must not be negative");
  if (value.falseAcceptRate > 0.01 || value.falseRejectRate > 0.01) throw new Error("calibration exceeds frozen 1% error target");
  if (value.minCoverage < 0 || value.minCoverage > 1) throw new Error("invalid calibration coverage target");
  return value;
}

export function artifactHash(value: Omit<CalibrationArtifact, "manifestHash">): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

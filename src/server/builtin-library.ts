import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { CellDistribution } from "../core/stats/index.js";

export const BUILTIN_REFERENCE_PREFIX = "builtin:pamela:";

export interface BuiltinReference {
  id: string;
  providerId: "builtin:pamela";
  modelClaimed: string;
  label: string;
  baseUrl: "https://openrouter.ai/";
  enrolledAt: string;
  batteryVersion: "pamela@1.0.0";
  normalizeVersion: "pamela@1";
  systemPromptVersion: "pamela-language@1.0.0";
  cellIds: string[];
  fingerprint: {
    params: { temperature: 1; maxTokens: 16; repetitions: "per-cell-counts" };
    protocolDegraded: false;
    cells: Record<string, CellDistribution>;
    source: BuiltinLibrary["source"];
  };
  sourceType: "builtin-research";
  readonly: true;
  trustNotice: string;
  datasetDoi: string;
  license: string;
}

interface BuiltinLibrary {
  libraryVersion: string;
  source: {
    title: string;
    author: string;
    datasetDoi: string;
    datasetLicense: string;
    softwareDoi: string;
    softwareLicense: string;
    runId: string;
    collectedAt: string;
    provider: string;
    trustNotice: string;
    promptsSha256: string;
    runConfigSha256: string;
    normalizedSha256: string;
  };
  protocol: {
    batteryVersion: "pamela@1.0.0";
    normalizeVersion: "pamela@1";
    systemPromptVersion: "pamela-language@1.0.0";
    cellIds: string[];
  };
  models: Array<{
    id: string;
    model: string;
    cells: Record<string, CellDistribution>;
  }>;
}

let cached: BuiltinLibrary | undefined;
function library(): BuiltinLibrary {
  if (cached) return cached;
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const path = resolve(moduleDir, "../data/builtin-fingerprints.json.gz");
  cached = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as BuiltinLibrary;
  if (cached.protocol.cellIds.length !== 40 || cached.models.some((model) => !model.id.startsWith(BUILTIN_REFERENCE_PREFIX))) {
    throw new Error("invalid built-in fingerprint library");
  }
  return cached;
}

function toReference(model: BuiltinLibrary["models"][number]): BuiltinReference {
  const source = library().source;
  return {
    id: model.id,
    providerId: "builtin:pamela",
    modelClaimed: model.model,
    label: `内置研究参考 · ${model.model}`,
    baseUrl: "https://openrouter.ai/",
    enrolledAt: source.collectedAt,
    batteryVersion: library().protocol.batteryVersion,
    normalizeVersion: library().protocol.normalizeVersion,
    systemPromptVersion: library().protocol.systemPromptVersion,
    cellIds: library().protocol.cellIds,
    fingerprint: {
      params: { temperature: 1, maxTokens: 16, repetitions: "per-cell-counts" },
      protocolDegraded: false,
      cells: model.cells,
      source,
    },
    sourceType: "builtin-research",
    readonly: true,
    trustNotice: source.trustNotice,
    datasetDoi: source.datasetDoi,
    license: source.datasetLicense,
  };
}

export type BuiltinReferenceSummary = Omit<BuiltinReference, "fingerprint">;

export function listBuiltinReferences(): BuiltinReferenceSummary[] {
  return library().models.map((model) => {
    const { fingerprint, ...summary } = toReference(model);
    return summary;
  });
}

export function getBuiltinReference(id: string): BuiltinReference | undefined {
  if (!id.startsWith(BUILTIN_REFERENCE_PREFIX)) return undefined;
  const model = library().models.find((candidate) => candidate.id === id);
  return model ? toReference(model) : undefined;
}

export function builtinLibraryInfo() {
  const value = library();
  return {
    libraryVersion: value.libraryVersion,
    models: value.models.length,
    cellsPerModel: value.protocol.cellIds.length,
    source: value.source,
  };
}

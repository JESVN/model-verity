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
  libraryVersion: string;
  libraryRevision?: number;
  libraryAppliedAt?: string;
  datasetRecordId?: string;
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
    source?: BuiltinLibrary["source"];
    libraryRevision?: {
      libraryVersion: string;
      revision: number;
      appliedAt?: string;
      recordId?: string;
      datasetVersion?: string;
    };
  }>;
}

let cached: BuiltinLibrary | undefined;
let activeLibraryRevision: BuiltinLibrary["models"][number]["libraryRevision"];

// Optional runtime overlay: when the server updates the built-in library from
// Zenodo, the updated library is stored in the data directory and read here
// in preference to the bundled artifact. Configure once at startup.
let overlayDir: string | undefined;

export function configureLibraryOverlay(dir: string | undefined): void {
  overlayDir = dir;
  cached = undefined;
  activeLibraryRevision = undefined;
}

export function invalidateLibraryCache(): void {
  cached = undefined;
  activeLibraryRevision = undefined;
}

function loadOverlay(dir: string): BuiltinLibrary | undefined {
  const index = JSON.parse(readFileSync(resolve(dir, "library-index.json"), "utf8")) as {
    currentFile?: string;
    versions?: Array<{ file: string; libraryVersion: string; appliedAt: string; zenodo?: { recordId?: string; version?: string } }>;
  };
  if (!index.currentFile) return undefined;
  const path = resolve(dir, index.currentFile);
  const parsed = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as BuiltinLibrary;
  if (parsed.protocol.cellIds.length !== 40 || parsed.models.some((model) => !model.id.startsWith(BUILTIN_REFERENCE_PREFIX))) {
    return undefined;
  }
  const current = index.versions?.find((version) => version.file === index.currentFile);
  if (current?.zenodo?.recordId) {
    activeLibraryRevision = {
      libraryVersion: current.libraryVersion,
      revision: Number(index.currentFile.match(/library-v(\d+)/)?.[1] ?? 1),
      appliedAt: current.appliedAt,
      recordId: current.zenodo.recordId,
      datasetVersion: current.zenodo.version,
    };
  }
  return parsed;
}

function library(): BuiltinLibrary {
  if (cached) return cached;
  if (overlayDir) {
    try {
      const overlay = loadOverlay(overlayDir);
      if (overlay) {
        cached = overlay;
        return cached;
      }
    } catch {
      // invalid overlay -> fall back to the bundled artifact
    }
  }
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const path = resolve(moduleDir, "../data/builtin-fingerprints.json.gz");
  cached = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as BuiltinLibrary;
  if (cached.protocol.cellIds.length !== 40 || cached.models.some((model) => !model.id.startsWith(BUILTIN_REFERENCE_PREFIX))) {
    throw new Error("invalid built-in fingerprint library");
  }
  return cached;
}

function toReference(model: BuiltinLibrary["models"][number]): BuiltinReference {
  const currentLibrary = library();
  const source = model.source ?? currentLibrary.source;
  const revision = model.libraryRevision ?? activeLibraryRevision;
  return {
    id: model.id,
    providerId: "builtin:pamela",
    modelClaimed: model.model,
    label: `内置研究参考 · ${model.model}`,
    baseUrl: "https://openrouter.ai/",
    enrolledAt: source.collectedAt,
    batteryVersion: currentLibrary.protocol.batteryVersion,
    normalizeVersion: currentLibrary.protocol.normalizeVersion,
    systemPromptVersion: currentLibrary.protocol.systemPromptVersion,
    cellIds: currentLibrary.protocol.cellIds,
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
    libraryVersion: revision?.libraryVersion ?? currentLibrary.libraryVersion,
    libraryRevision: revision?.revision,
    libraryAppliedAt: revision?.appliedAt,
    datasetRecordId: revision?.recordId,
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

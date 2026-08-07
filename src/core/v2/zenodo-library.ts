import type { CellDistribution } from "../stats/index.js";

/**
 * Pure logic for rebuilding PAMELA built-in reference libraries from a Zenodo
 * dataset. Exactly mirrors scripts/build-builtin-library.mjs so that a runtime
 * update from the website aggregates fingerprints with identical semantics to
 * the off-line build script. No I/O here; the server module streams rows in.
 */

export const ZENODO_LANGUAGES: readonly string[] = ["en", "ru", "zh", "ar"];
export const ZENODO_MIN_VALID_PER_CELL = 10;
export const ZENODO_BATTERY = "pamela@1.0.0";
export const ZENODO_NORMALIZE = "pamela@1";
export const ZENODO_SYSTEM_PROMPT = "pamela-language@1.0.0";

export interface PromptTask {
  id: string;
  paper?: number;
}

/** The 40 paper-1 cells used as fingerprints (10 tasks x 4 languages). */
export function paperCellIds(tasks: readonly PromptTask[], languages: readonly string[] = ZENODO_LANGUAGES): string[] {
  return tasks
    .filter((task) => task.paper === 1)
    .flatMap((task) => languages.map((language) => `${language}:${task.id}`));
}

export interface AccumCell {
  counts: Record<string, number>;
  nValid: number;
  nInvalid: number;
  nRefusal: number;
  nEmpty: number;
  nError: number;
}

export function newAccumCell(): AccumCell {
  return { counts: {}, nValid: 0, nInvalid: 0, nRefusal: 0, nEmpty: 0, nError: 0 };
}

export function feedAccumCell(cell: AccumCell, answerClass: unknown, normalized: unknown): void {
  if (answerClass === "valid" && typeof normalized === "string") {
    cell.counts[normalized] = (cell.counts[normalized] ?? 0) + 1;
    cell.nValid += 1;
  } else if (answerClass === "refusal") cell.nRefusal += 1;
  else if (answerClass === "empty") cell.nEmpty += 1;
  else cell.nInvalid += 1; // includes invalid and post_reasoning
}

export function toCellDistribution(cell: AccumCell): CellDistribution {
  const probs: Record<string, number> = {};
  if (cell.nValid > 0) {
    for (const [answer, count] of Object.entries(cell.counts)) probs[answer] = count / cell.nValid;
  }
  return { ...cell, probs };
}

export interface LumasRow {
  run_id?: unknown;
  temperature?: unknown;
  task_id?: unknown;
  lang?: unknown;
  model?: unknown;
  answer_class?: unknown;
  normalized?: unknown;
}

export interface ScanOptions {
  runIds: ReadonlySet<string>;
  tasks: ReadonlySet<string>;
  languages: readonly string[];
}

/** One pass over normalized rows -> per model per cell accumulated counts. */
export function scanRows(rows: Iterable<LumasRow>, options: ScanOptions): Map<string, Map<string, AccumCell>> {
  const byModel = new Map<string, Map<string, AccumCell>>();
  for (const row of rows) {
    if (typeof row.run_id !== "string" || !options.runIds.has(row.run_id)) continue;
    if (row.temperature !== 1) continue;
    if (typeof row.task_id !== "string" || !options.tasks.has(row.task_id)) continue;
    if (typeof row.lang !== "string" || !options.languages.includes(row.lang)) continue;
    if (typeof row.model !== "string" || !row.model) continue;
    let cells = byModel.get(row.model);
    if (!cells) { cells = new Map<string, AccumCell>(); byModel.set(row.model, cells); }
    const cellId = `${row.lang}:${row.task_id}`;
    let cell = cells.get(cellId);
    if (!cell) { cell = newAccumCell(); cells.set(cellId, cell); }
    feedAccumCell(cell, row.answer_class, row.normalized);
  }
  return byModel;
}

export interface ModelQualification {
  qualified: boolean;
  missingCells: string[];
  belowMinimumCells: string[];
  nValid: number;
}

/** Same acceptance rule as build-builtin-library.mjs: all cells present, nValid>=10 each. */
export function qualifyModel(
  model: string,
  cells: Map<string, AccumCell>,
  expectedCellIds: readonly string[],
  minValid = ZENODO_MIN_VALID_PER_CELL,
): ModelQualification {
  const missing = expectedCellIds.filter((id) => !cells.has(id));
  const belowSimilarly = expectedCellIds.filter((id) => (cells.get(id)?.nValid ?? 0) < minValid);
  let nValid = 0;
  for (const [id, cell] of cells) if (expectedCellIds.includes(id)) nValid += cell.nValid;
  return { qualified: missing.length === 0 && belowSimilarly.length === 0, missingCells: missing, belowMinimumCells: belowSimilarly, nValid };
}

export interface MethodLibrary {
  id: string;
  model: string;
  cells: Record<string, CellDistribution>;
  /** Per-model provenance is required when a partial update preserves older samples. */
  source?: BuiltinSource;
  libraryRevision?: {
    libraryVersion: string;
    revision: number;
    appliedAt?: string;
    recordId?: string;
    datasetVersion?: string;
  };
}
export interface BuiltinSource {
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
}

export interface BuiltinProtocol {
  batteryVersion: string;
  normalizeVersion: string;
  systemPromptVersion: string;
  temperature: number;
  maxTokens: number;
  nominalRepetitions?: number;
  repetitionsNote: string;
  cellIds: string[];
  minValidPerCell: number;
}

export interface BuiltinLibraryV2 {
  schemaVersion: number;
  libraryVersion: string;
  source: BuiltinSource;
  protocol: BuiltinProtocol;
  build: {
    scannedRecords?: number;
    includedModels: number;
    excludedModels: number;
    exclusionRule: string;
    excluded: Array<Record<string, unknown>>;
  };
  models: MethodLibrary[];
}

/** Build the library object for the selected qualified models, preserving order. */
export function buildLibrary(
  byModel: Map<string, Map<string, AccumCell>>,
  expectedCellIds: readonly string[],
  options: {
    libraryVersion: string;
    source: BuiltinSource;
    protocol: Omit<BuiltinProtocol, "cellIds">;
    ids: Iterable<string>;
  },
): BuiltinLibraryV2 {
  const models: MethodLibrary[] = [];
  const excluded: Array<Record<string, unknown>> = [];
  let included = 0;
  let excludedCount = 0;
  for (const id of options.ids) {
    const cellsMap = byModel.get(id);
    if (!cellsMap) { excludedCount += 1; excluded.push({ id, reason: "no data" }); continue; }
    const qualified = qualifyModel(id, cellsMap, expectedCellIds);
    if (!qualified.qualified) {
      excludedCount += 1;
      excluded.push({ id, missingCells: qualified.missingCells.length, belowMinimumCells: qualified.belowMinimumCells.length });
      continue;
    }
    const cells: Record<string, CellDistribution> = {};
    for (const cellId of expectedCellIds) {
      const cell = cellsMap.get(cellId);
      if (cell) cells[cellId] = toCellDistribution(cell);
    }
    models.push({ id: `builtin:pamela:${id}`, model: id, cells, source: options.source });
    included += 1;
  }
  return {
    schemaVersion: 1,
    libraryVersion: options.libraryVersion,
    source: options.source,
    protocol: { ...options.protocol, cellIds: [...expectedCellIds] },
    build: { includedModels: included, excludedModels: excludedCount, exclusionRule: "all 40 paper-1 cells present and nValid >= 10 in every cell", excluded },
    models,
  };
}

/** Runtime overlay readers must accept the same invariants as the bundled artifact. */
export function libraryHealth(library: BuiltinLibraryV2): { ok: boolean; reason?: string } {
  if (!library?.protocol) return { ok: false, reason: "missing protocol" };
  if (library.protocol.cellIds.length !== 40) return { ok: false, reason: `expected 40 cells, got ${library.protocol.cellIds.length}` };
  if (library.models.some((model) => !model.id.startsWith("builtin:pamela:"))) return { ok: false, reason: "invalid model id prefix" };
  return { ok: true };
}
import type { NormalizedAnswer, Validity } from "../normalize/index.js";

export type Distribution = Record<string, number>;
export interface CellDistribution {
  counts: Record<string, number>;
  probs: Distribution;
  nValid: number;
  nInvalid: number;
  nRefusal: number;
  nEmpty: number;
  nError: number;
}

export function empiricalDistribution(
  answers: readonly (NormalizedAnswer | { validity: "error" })[],
): CellDistribution {
  const counts: Record<string, number> = {};
  const validity: Record<Validity | "error", number> = {
    valid: 0,
    invalid: 0,
    refusal: 0,
    empty: 0,
    error: 0,
  };
  for (const answer of answers) {
    validity[answer.validity] += 1;
    if (answer.validity === "valid") counts[answer.category!] = (counts[answer.category!] ?? 0) + 1;
  }
  const probs = Object.fromEntries(
    Object.entries(counts).map(([key, count]) => [key, count / validity.valid]),
  );
  return {
    counts,
    probs,
    nValid: validity.valid,
    nInvalid: validity.invalid,
    nRefusal: validity.refusal,
    nEmpty: validity.empty,
    nError: validity.error,
  };
}

function assertDistribution(value: Distribution): void {
  const entries = Object.values(value);
  if (entries.some((p) => !Number.isFinite(p) || p < 0)) throw new Error("distribution contains invalid probability");
  const sum = entries.reduce((a, b) => a + b, 0);
  if (entries.length && Math.abs(sum - 1) > 1e-8) throw new Error(`distribution probabilities sum to ${sum}, not 1`);
}

function entropy(distribution: Distribution): number {
  return Object.values(distribution).reduce((sum, probability) => {
    if (probability === 0) return sum;
    return sum - probability * Math.log2(probability);
  }, 0);
}

export function jsDivergence(left: Distribution, right: Distribution): number {
  assertDistribution(left);
  assertDistribution(right);
  const support = new Set([...Object.keys(left), ...Object.keys(right)]);
  if (support.size === 0) throw new Error("cannot compare empty distributions");
  const p: Distribution = {};
  const q: Distribution = {};
  const midpoint: Distribution = {};
  for (const key of support) {
    p[key] = left[key] ?? 0;
    q[key] = right[key] ?? 0;
    midpoint[key] = (p[key] + q[key]) / 2;
  }
  const result = entropy(midpoint) - (entropy(p) + entropy(q)) / 2;
  return Math.max(0, Math.min(1, result));
}

export interface ComparableFingerprint {
  cells: Record<string, CellDistribution>;
}
export interface CellDistance { cellId: string; jsd: number; nRef: number; nAudit: number }
export interface ExcludedCellDistance { cellId: string; reason: string; nRef?: number; nAudit?: number; minValid: number }
export interface FingerprintDistance {
  score?: number;
  cells: CellDistance[];
  excluded: ExcludedCellDistance[];
}

/** Minimum valid samples for a cell to enter average JSD.
 *  Enrollment keeps paper-style n>=10. Audit adapts to the profile budget so
 *  Quick (10 reps) is not forced into an all-or-nothing 10/10 validity gate. */
export function minValidForRepetitions(repetitions: number, floor = 5): number {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("invalid repetitions");
  if (!Number.isSafeInteger(floor) || floor < 1) throw new Error("invalid floor");
  return Math.max(floor, Math.min(10, Math.ceil(repetitions * 0.7)));
}

export function compareFingerprints(
  reference: ComparableFingerprint,
  audit: ComparableFingerprint,
  selectedCellIds: readonly string[],
  minValid = 10,
): FingerprintDistance {
  const cells: CellDistance[] = [];
  const excluded: ExcludedCellDistance[] = [];
  for (const cellId of selectedCellIds) {
    const ref = reference.cells[cellId];
    const candidate = audit.cells[cellId];
    if (!ref || !candidate) {
      excluded.push({ cellId, reason: "missing_cell", nRef: ref?.nValid, nAudit: candidate?.nValid, minValid });
      continue;
    }
    if (ref.nValid < minValid) {
      excluded.push({ cellId, reason: "reference_below_minimum", nRef: ref.nValid, nAudit: candidate.nValid, minValid });
      continue;
    }
    if (candidate.nValid < minValid) {
      excluded.push({ cellId, reason: "audit_below_minimum", nRef: ref.nValid, nAudit: candidate.nValid, minValid });
      continue;
    }
    cells.push({ cellId, jsd: jsDivergence(ref.probs, candidate.probs), nRef: ref.nValid, nAudit: candidate.nValid });
  }
  return {
    score: cells.length ? cells.reduce((sum, cell) => sum + cell.jsd, 0) / cells.length : undefined,
    cells,
    excluded,
  };
}

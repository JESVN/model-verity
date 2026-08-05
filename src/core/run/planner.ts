import { BATTERY, type BatteryCell } from "../battery/index.js";

export type RunProfile = "quick" | "audit" | "full" | "enroll";
export interface ProfileBudget { cells: number; repetitions: number }
export const PROFILE_BUDGETS: Record<RunProfile, ProfileBudget> = {
  quick: { cells: 4, repetitions: 10 },
  audit: { cells: 8, repetitions: 15 },
  full: { cells: 40, repetitions: 30 },
  enroll: { cells: 8, repetitions: 30 },
};

export interface PlannedSample {
  id: string;
  cell: BatteryCell;
  repetition: number;
}
export interface RunPlan {
  seed: string;
  profile: RunProfile;
  cells: BatteryCell[];
  samples: PlannedSample[];
  repetitions: number;
}

function xmur3(value: string): () => number {
  let h = 1779033703 ^ value.length;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const random = mulberry32(xmur3(seed)());
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function selectCells(count: number, seed: string, available: readonly BatteryCell[] = BATTERY): BatteryCell[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > available.length) throw new Error("invalid cell count");
  // Round-robin language groups after seeded task ordering avoids one-language plans.
  const taskOrder = seededShuffle([...new Set(available.map((cell) => cell.task))], `${seed}:tasks`);
  const languageOrder = seededShuffle([...new Set(available.map((cell) => cell.language))], `${seed}:languages`);
  const candidates: BatteryCell[] = [];
  for (let round = 0; round < taskOrder.length; round += 1) {
    for (let li = 0; li < languageOrder.length; li += 1) {
      const task = taskOrder[(round + li) % taskOrder.length];
      const language = languageOrder[li];
      const cell = available.find((candidate) => candidate.task === task && candidate.language === language);
      if (cell && !candidates.some((candidate) => candidate.id === cell.id)) candidates.push(cell);
    }
  }
  return candidates.slice(0, count);
}

export function createRunPlan(
  profile: RunProfile,
  seed: string,
  options: { repetitions?: number; cellIds?: readonly string[]; battery?: readonly BatteryCell[] } = {},
): RunPlan {
  const budget = PROFILE_BUDGETS[profile];
  const repetitions = options.repetitions ?? budget.repetitions;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("invalid repetitions");
  const battery = options.battery ?? BATTERY;
  const cells = options.cellIds
    ? options.cellIds.map((id) => {
        const cell = battery.find((candidate) => candidate.id === id);
        if (!cell) throw new Error(`unknown battery cell: ${id}`);
        return cell;
      })
    : selectCells(budget.cells, seed, battery);
  const samples = seededShuffle(
    cells.flatMap((cell) => Array.from({ length: repetitions }, (_, repetition) => ({
      id: `${cell.id}:${repetition + 1}`,
      cell,
      repetition: repetition + 1,
    }))),
    `${seed}:samples`,
  );
  return { seed, profile, cells, samples, repetitions };
}

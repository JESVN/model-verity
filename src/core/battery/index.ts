import source from "./prompts.json" with { type: "json" };

export const LANGUAGES = ["en", "ru", "zh", "ar"] as const;
export const TASKS = [
  "random_number_1_100",
  "random_number_1_10",
  "favorite_number",
  "random_letter",
  "random_word",
  "random_color",
  "favorite_color",
  "random_animal",
  "random_city",
  "coin_flip",
] as const;

export type Language = (typeof LANGUAGES)[number];
export type ProbeTask = (typeof TASKS)[number];

export interface BatteryCell {
  id: string;
  /** Protocol-specific task identifier. */
  task: string;
  language: Language;
  prompt: string;
}

export const BATTERY_VERSION = source.version;
export const SYSTEM_PROMPT_VERSION = source.systemPromptVersion;
export const ONE_WORD_SYSTEM = source.systemPrompt;
export const BATTERY_SOURCE_NOTE = source.source;

export const BATTERY: readonly BatteryCell[] = Object.freeze(
  source.cells.map((cell) => ({
    ...cell,
    task: cell.task as ProbeTask,
    language: cell.language as Language,
    id: `${cell.language}:${cell.task}`,
  })),
);

if (BATTERY.length !== TASKS.length * LANGUAGES.length) {
  throw new Error(`invalid battery: expected 40 cells, got ${BATTERY.length}`);
}
if (new Set(BATTERY.map((cell) => cell.id)).size !== BATTERY.length) {
  throw new Error("invalid battery: duplicate cell ids");
}

export function batteryCell(id: string): BatteryCell {
  const cell = BATTERY.find((candidate) => candidate.id === id);
  if (!cell) throw new Error(`unknown battery cell: ${id}`);
  return cell;
}

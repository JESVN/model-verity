import source from "./pamela-prompts.json" with { type: "json" };
import type { BatteryCell, Language } from "./index.js";

const PAPER_TASKS = source.tasks.filter((task) => task.paper === 1);

export const PAMELA_BATTERY_VERSION = `pamela@${source.version}`;
export const PAMELA_NORMALIZE_VERSION = "pamela@1";
export const PAMELA_SYSTEM_PROMPT_VERSION = `pamela-language@${source.version}`;
export const PAMELA_SOURCE_NOTE =
  "Exact paper-1 prompts from Zenodo software DOI 10.5281/zenodo.21278793.";

export const PAMELA_BATTERY: readonly BatteryCell[] = Object.freeze(
  PAPER_TASKS.flatMap((task) =>
    source.languages.map((language) => ({
      id: `${language}:${task.id}`,
      task: task.id,
      language: language as Language,
      prompt: task.prompts[language as keyof typeof task.prompts],
    })),
  ),
);

if (PAMELA_BATTERY.length !== 40 || new Set(PAMELA_BATTERY.map((cell) => cell.id)).size !== 40) {
  throw new Error("invalid PAMELA paper-1 battery");
}

export function pamelaSystemPrompt(language: Language): string {
  return source.system_prompts[language];
}

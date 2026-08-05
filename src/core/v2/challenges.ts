import { createHash, randomUUID } from "node:crypto";
import { PAMELA_BATTERY, pamelaSystemPrompt } from "../battery/pamela.js";
import type { ProtocolComparability, ChallengeManifest } from "./types.js";
import { V2_CHALLENGE_VERSION } from "./types.js";

export function createChallengeManifest(input: { seed?: string; cells: number; repetitions: number; concurrency: number; protocolComparability: ProtocolComparability; promptMode?: "fixed" | "marked" }): ChallengeManifest {
  const seed = input.seed ?? randomUUID();
  if (!Number.isSafeInteger(input.cells) || input.cells < 2 || input.cells > PAMELA_BATTERY.length) throw new Error("invalid challenge cell count");
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 2 || input.repetitions > 45) throw new Error("invalid challenge repetitions");
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 2) throw new Error("invalid pair concurrency");
  const random = seededRandom(seed);
  const cells = stratifiedCells(input.cells, random);
  const promptMode = input.promptMode ?? "marked";
  const items = cells.flatMap((cell, cellIndex) => Array.from({ length: input.repetitions }, (_, repetition) => {
    const nonce = Math.floor(random() * 0xffff_ffff).toString(36).padStart(7, "0");
    const system = pamelaSystemPrompt(cell.language);
    const user = promptMode === "fixed" ? cell.prompt : `${cell.prompt}\n\nRequest marker: ${nonce}. The marker has no semantic meaning; ignore it.`;
    const challengeId = `${cell.id}:${repetition}:${nonce}`;
    return {
      challengeId,
      pairId: `pair:${cellIndex}:${repetition}:${nonce}`,
      blockIndex: 0,
      cellId: cell.id,
      repetition,
      system,
      user,
      requestHash: createHash("sha256").update(`${system}\0${user}`).digest("hex"),
    };
  }));
  const createdAt = new Date().toISOString();
  const contentHash = createHash("sha256").update(JSON.stringify({ version: V2_CHALLENGE_VERSION, seed, promptMode, items })).digest("hex");
  return { version: V2_CHALLENGE_VERSION, seed, createdAt, contentHash, concurrency: input.concurrency, protocolComparability: input.protocolComparability, promptMode, items };
}

function stratifiedCells(count: number, random: () => number) {
  const groups = new Map<string, typeof PAMELA_BATTERY[number][]>();
  for (const cell of PAMELA_BATTERY) groups.set(cell.language, [...(groups.get(cell.language) ?? []), cell]);
  for (const values of groups.values()) shuffle(values, random);
  const selected: typeof PAMELA_BATTERY[number][] = [];
  const languages = [...groups.keys()].sort();
  let cursor = 0;
  while (selected.length < count) {
    const language = languages[cursor % languages.length];
    const candidate = groups.get(language)?.shift();
    if (candidate) selected.push(candidate);
    cursor += 1;
  }
  return selected;
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
}

function seededRandom(seed: string): () => number {
  let state = 0;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 0x45d9f3b);
  return () => {
    state = Math.imul(state ^ state >>> 16, 0x45d9f3b);
    state = Math.imul(state ^ state >>> 16, 0x45d9f3b);
    state ^= state >>> 16;
    return (state >>> 0) / 4294967296;
  };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PAMELA_BATTERY } from "../src/core/battery/pamela.js";
import {
  ZENODO_LANGUAGES,
  buildLibrary,
  feedAccumCell,
  libraryHealth,
  newAccumCell,
  paperCellIds,
  qualifyModel,
  scanRows,
  toCellDistribution,
  type AccumCell,
  type BuiltinLibraryV2,
} from "../src/core/v2/zenodo-library.js";
import { EXPECTED_PAMELA_PROMPTS_SHA256 } from "../src/server/zenodo-update.js";

const PAPER_TASK_IDS = [...new Set(PAMELA_BATTERY.map((cell) => cell.task))];
const EXPECTED_CELL_IDS = PAMELA_BATTERY.map((cell) => cell.id);

test("paper cell ids equal the runtime PAMELA battery (40 cells)", () => {
  const tasks = PAPER_TASK_IDS.map((id) => ({ id, paper: 1 }));
  assert.equal(paperCellIds(tasks, ZENODO_LANGUAGES).length, 40);
  assert.deepEqual(paperCellIds(tasks, ZENODO_LANGUAGES).sort(), [...EXPECTED_CELL_IDS].sort());
});

test("expected prompts sha256 matches the shipped battery file", () => {
  const bytes = readFileSync(resolve(process.cwd(), "src/core/battery/pamela-prompts.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), EXPECTED_PAMELA_PROMPTS_SHA256);
});

function row(model: string, cellId: string): Record<string, unknown> {
  const [lang, task] = cellId.split(":");
  return { run_id: "main-03", temperature: 1, task_id: task, lang, model, answer_class: "valid", normalized: "heads" };
}

function rowsFor(model: string, valid = 12): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const cellId of EXPECTED_CELL_IDS) {
    for (let i = 0; i < valid; i += 1) rows.push(row(model, cellId));
  }
  return rows;
}

test("scanRows aggregates, qualification enforces 40 cells and nValid>=10, buildLibrary round-trips", () => {
  const expected = new Set(EXPECTED_CELL_IDS);
  const tasks = new Set(PAPER_TASK_IDS);
  const byModel = scanRows([...rowsFor("mock/a", 12), ...rowsFor("mock/b", 12), ...rowsFor("mock/c", 3)], {
    runIds: new Set(["main-03"]),
    tasks,
    languages: ZENODO_LANGUAGES,
  });
  assert.equal(byModel.size, 3);
  const qualifiedA = qualifyModel("mock/a", byModel.get("mock/a")!, EXPECTED_CELL_IDS);
  assert.equal(qualifiedA.qualified, true);
  assert.equal(qualifiedA.nValid, 12 * 40);
  const qualifiedC = qualifyModel("mock/c", byModel.get("mock/c")!, EXPECTED_CELL_IDS);
  assert.equal(qualifiedC.qualified, false);
  assert.equal(qualifiedC.belowMinimumCells.length, 40);

  const library = buildLibrary(byModel, EXPECTED_CELL_IDS, {
    libraryVersion: "pamela-zenodo-main-03@1",
    source: {
      title: "t", author: "a", datasetDoi: "10.5281/zenodo.21278557", datasetLicense: "CC BY 4.0",
      softwareDoi: "10.5281/zenodo.21278793", softwareLicense: "MIT", runId: "main-03",
      collectedAt: "2026-08-01T00:00:00Z", provider: "OpenRouter", trustNotice: "research",
      promptsSha256: EXPECTED_PAMELA_PROMPTS_SHA256, runConfigSha256: "", normalizedSha256: "x",
    },
    protocol: { batteryVersion: "pamela@1.0.0", normalizeVersion: "pamela@1", systemPromptVersion: "pamela-language@1.0.0", temperature: 1, maxTokens: 16, nominalRepetitions: 30, repetitionsNote: "", minValidPerCell: 10 },
    ids: ["mock/a", "mock/b", "mock/c"],
  }) as BuiltinLibraryV2;
  assert.equal(library.models.length, 2);
  assert.deepEqual(library.build.excludedModels, 1);
  assert.equal(library.models[0].id, "builtin:pamela:mock/a");
  assert.equal(Object.keys(library.models[0].cells).length, 40);
  assert.equal(libraryHealth(library).ok, true);
  // probs are normalized to nValid
  const probs = Object.values(library.models[0].cells)[0].probs;
  assert.equal(probs["heads"], 1);
});

test("feedAccumCell classifies refusal/empty/invalid like the build script", () => {
  const cell = newAccumCell();
  feedAccumCell(cell, "valid", "red");
  feedAccumCell(cell, "refusal", undefined);
  feedAccumCell(cell, "empty", undefined);
  feedAccumCell(cell, "invalid", "blue");
  const dist = toCellDistribution(cell);
  assert.equal(dist.nValid, 1);
  assert.equal(dist.nRefusal, 1);
  assert.equal(dist.nEmpty, 1);
  assert.equal(dist.nInvalid, 1);
  assert.deepEqual(dist.probs, { red: 1 });
});

#!/usr/bin/env node
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const normalizedPath = resolve(ROOT, "pamela-publish-data/data/derived/normalized.jsonl");
const manifestPath = resolve(ROOT, "pamela-publish-data/data/runs/main-02/manifest.json");
const promptsPath = resolve(ROOT, "src/core/battery/pamela-prompts.json");
const runConfigPath = resolve(ROOT, "src/core/battery/pamela-run.config.json");
const outputPath = resolve(ROOT, "src/data/builtin-fingerprints.json.gz");
const paperTasks = new Set([
  "num100-random", "num10-random", "num-favorite", "letter-random", "word-random",
  "color-random", "color-favorite", "animal-random", "city-random", "coin-flip",
]);
const languages = ["en", "ru", "zh", "ar"];
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const promptsBytes = readFileSync(promptsPath);
const runConfigBytes = readFileSync(runConfigPath);
const prompts = JSON.parse(promptsBytes);
const runConfig = JSON.parse(runConfigBytes);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (sha256(promptsBytes) !== manifest.prompts_sha256) {
  throw new Error("PAMELA prompt SHA-256 does not match main-02 manifest");
}
if (sha256(runConfigBytes) !== manifest.run_config_sha256) {
  throw new Error("PAMELA run config SHA-256 does not match main-02 manifest");
}

const modelCells = new Map();
let scanned = 0;
for await (const line of createInterface({ input: createReadStream(normalizedPath), crlfDelay: Infinity })) {
  if (!line) continue;
  const row = JSON.parse(line);
  scanned += 1;
  if (row.run_id !== "main-02" || row.temperature !== 1 || !paperTasks.has(row.task_id)) continue;
  const cells = modelCells.get(row.model) ?? new Map();
  modelCells.set(row.model, cells);
  const cellId = `${row.lang}:${row.task_id}`;
  const cell = cells.get(cellId) ?? { counts: {}, nValid: 0, nInvalid: 0, nRefusal: 0, nEmpty: 0, nError: 0 };
  cells.set(cellId, cell);
  if (row.answer_class === "valid" && typeof row.normalized === "string") {
    cell.counts[row.normalized] = (cell.counts[row.normalized] ?? 0) + 1;
    cell.nValid += 1;
  } else if (row.answer_class === "refusal") cell.nRefusal += 1;
  else if (row.answer_class === "empty") cell.nEmpty += 1;
  else cell.nInvalid += 1; // includes invalid and post_reasoning
}

const expectedCellIds = prompts.tasks
  .filter((task) => task.paper === 1)
  .flatMap((task) => languages.map((language) => `${language}:${task.id}`));
const models = [];
const excluded = [];
for (const [model, cells] of [...modelCells].sort(([a], [b]) => a.localeCompare(b))) {
  const missing = expectedCellIds.filter((id) => !cells.has(id));
  const belowMinimum = expectedCellIds.filter((id) => (cells.get(id)?.nValid ?? 0) < 10);
  if (missing.length || belowMinimum.length) {
    excluded.push({ model, missingCells: missing.length, belowMinimumCells: belowMinimum.length });
    continue;
  }
  const compactCells = {};
  for (const id of expectedCellIds) {
    const cell = cells.get(id);
    compactCells[id] = {
      ...cell,
      probs: Object.fromEntries(Object.entries(cell.counts).map(([answer, count]) => [answer, count / cell.nValid])),
    };
  }
  models.push({ id: `builtin:pamela:${model}`, model, cells: compactCells });
}

const library = {
  schemaVersion: 1,
  libraryVersion: "pamela-main-02@1",
  source: {
    title: "Single-token output distributions as behavioral fingerprints of large language models",
    author: "Tomáš Bruckner",
    datasetDoi: "10.5281/zenodo.21278557",
    datasetLicense: "CC BY 4.0",
    softwareDoi: "10.5281/zenodo.21278793",
    softwareLicense: "MIT",
    runId: "main-02",
    collectedAt: manifest.created_utc,
    provider: "OpenRouter aggregator with recorded upstream routing",
    trustNotice: "Research/community reference; not first-party vendor attestation.",
    promptsSha256: manifest.prompts_sha256,
    runConfigSha256: manifest.run_config_sha256,
    normalizedSha256: sha256(readFileSync(normalizedPath)),
  },
  protocol: {
    batteryVersion: "pamela@1.0.0",
    normalizeVersion: "pamela@1",
    systemPromptVersion: "pamela-language@1.0.0",
    temperature: runConfig.temperatures.main.find((entry) => entry.t === 1)?.t,
    maxTokens: runConfig.request.max_tokens,
    nominalRepetitions: runConfig.temperatures.main.find((entry) => entry.t === 1)?.reps,
    repetitionsNote: "main plan nominally uses 30; expensive models may use 0.5 factor; authoritative per-cell totals are stored in counts and validity fields",
    cellIds: expectedCellIds,
    minValidPerCell: 10,
  },
  build: {
    scannedRecords: scanned,
    includedModels: models.length,
    excludedModels: excluded.length,
    exclusionRule: "all 40 paper-1 cells present and nValid >= 10 in every cell",
    excluded,
  },
  models,
};
const json = Buffer.from(`${JSON.stringify(library)}\n`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, gzipSync(json, { level: 9, mtime: 0 }));
const outputBytes = readFileSync(outputPath);
console.log(JSON.stringify({ outputPath, uncompressedBytes: json.length, compressedBytes: outputBytes.length, sha256: sha256(outputBytes), includedModels: models.length, excludedModels: excluded.length }, null, 2));

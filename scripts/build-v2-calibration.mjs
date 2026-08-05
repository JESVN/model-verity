#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? "artifacts/calibration/custom-v2.json";
if (!inputPath) {
  console.error("usage: node scripts/build-v2-calibration.mjs <input.json> [output.json]");
  process.exit(2);
}
const source = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const required = ["id","version","frameworkVersion","vendor","product","surface","protocols","profile","cellIds","sampleSize","genuineDistances","impostorDistances","supportMax","anomalyMin","falseAcceptRate","falseRejectRate","minCoverage","createdAt","source"];
for (const key of required) if (source[key] == null) throw new Error(`missing ${key}`);
if (source.falseAcceptRate > .01 || source.falseRejectRate > .01) throw new Error("artifact exceeds frozen 1% strong-conclusion error target");
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}` : JSON.stringify(value);
const manifestHash = createHash("sha256").update(stable(source)).digest("hex");
const artifact = { ...source, manifestHash };
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ output: resolve(outputPath), manifestHash, genuine: source.genuineDistances.length, impostor: source.impostorDistances.length }));

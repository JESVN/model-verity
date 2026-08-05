import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PAMELA_BATTERY } from "../src/core/battery/pamela.js";
import { configureLibraryOverlay, getBuiltinReference, listBuiltinReferences } from "../src/server/builtin-library.js";
import {
  EXPECTED_PAMELA_PROMPTS_SHA256,
  ZenodoUpdateManager,
  type ZenodoUpdateStatus,
} from "../src/server/zenodo-update.js";

// ---------- minimal stored (uncompressed) zip writer for fixtures ----------

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: Array<{ name: string; content: string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, eocd]);
}

// ---------- fixture dataset ----------

const CELL_IDS = PAMELA_BATTERY.map((cell) => cell.id);

function datasetRows(model: string, runId: string, valid: number): string {
  const lines: string[] = [];
  for (const cellId of CELL_IDS) {
    const [lang, task] = cellId.split(":");
    for (let i = 0; i < valid; i += 1) {
      lines.push(JSON.stringify({ run_id: runId, temperature: 1, task_id: task, lang, model, answer_class: "valid", normalized: "heads" }));
    }
  }
  return `${lines.join("\n")}\n`;
}

function datasetZip(manifest: Record<string, unknown>, models: Array<[string, number]>): Buffer {
  const rows = models.map(([model, valid]) => datasetRows(model, String(manifest.run_id), valid)).join("");
  return storedZip([
    { name: "data/runs/main-03/manifest.json", content: JSON.stringify(manifest) },
    { name: "data/derived/normalized.jsonl", content: rows },
  ]);
}

const GOOD_MANIFEST = {
  run_id: "main-03",
  prompts_sha256: EXPECTED_PAMELA_PROMPTS_SHA256,
  run_config_sha256: "deadbeef",
  created_utc: "2026-08-01T00:00:00Z",
};

// ---------- mock Zenodo server ----------

interface MockContext {
  port: number;
  record: any;
  zip: Buffer;
  manifest: Record<string, unknown>;
  metadataCalls: number;
}

async function startMock(): Promise<MockContext> {
  const context: MockContext = {
    port: 0,
    record: {} as any,
    zip: Buffer.alloc(0),
    manifest: GOOD_MANIFEST,
    metadataCalls: 0,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${context.port}`);
    if (url.pathname === "/api/records/21278557") {
      context.metadataCalls += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(context.record));
      return;
    }
    if (url.pathname === "/files/pamela.zip") {
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-length", String(context.zip.length));
      res.end(context.zip);
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  context.port = typeof address === "object" && address ? address.port : 0;
  context.record = {
    id: 900001,
    conceptrecid: 21278557,
    updated: "2026-08-02T00:00:00Z",
    metadata: { version: "main-03", title: "PAMELA v3" },
    files: [{ key: "pamela.zip", size: context.zip.length, links: { self: `http://127.0.0.1:${context.port}/files/pamela.zip` } }],
  };
  (context as any).closeMock = async () => await new Promise<void>((resolve) => server.close(() => resolve()));
  return context;
}

function makeManager(dataDir: string, mock: MockContext): ZenodoUpdateManager {
  const fetchImpl = async (rawUrl: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rewritten = String(rawUrl).replace("https://zenodo.org", `http://127.0.0.1:${mock.port}`);
    return fetch(rewritten, init);
  };
  return new ZenodoUpdateManager({ dataDir, fetchImpl, hostCheck: async () => undefined });
}

async function waitJob(manager: ZenodoUpdateManager): Promise<ZenodoUpdateStatus> {
  for (let i = 0; i < 300; i += 1) {
    const status = manager.status();
    const job = status.prepareJob;
    if (job && (job.status === "done" || job.status === "failed" || job.status === "canceled")) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("prepare job did not finish");
}

test("Zenodo update: check -> prepare -> apply selected -> rollback -> clean cache", async () => {
  const mock = await startMock();
  mock.zip = datasetZip(GOOD_MANIFEST, [["openai/gpt-5.6-sol", 12], ["anthropic/claude-opus-5", 12]]);
  const dir = await mkdtemp(join(tmpdir(), "mv-zenodo-"));
  const manager = makeManager(dir, mock);
  try {
    const initial = manager.status();
    assert.equal(initial.current.source, "bundled");
    assert.equal(initial.current.models, 33);
    assert.equal(initial.latest, null);
    assert.equal(initial.updateAvailable, false);

    const checked = await manager.check(true);
    assert.equal(checked.latest?.recordId, "900001");
    assert.equal(checked.latest?.version, "main-03");
    assert.equal(checked.updateAvailable, true);
    assert.equal(mock.metadataCalls, 1);
    // rate limit: a second check without refresh must not hit the network
    await manager.check(false);
    assert.equal(mock.metadataCalls, 1);

    // prepare downloads and scans the dataset once
    manager.prepare();
    const prepared = await waitJob(manager);
    assert.equal(prepared.prepareJob?.status, "done", prepared.prepareJob?.error ?? "prepare failed");
    assert.equal(prepared.catalog.ready, true);
    assert.equal(prepared.catalog.total, 2);
    assert.equal(prepared.catalog.qualified, 2);
    assert.ok(prepared.cacheBytes > 0);

    // apply the selected models (whole-library replacement with new snapshots)
    const applied = manager.updateFromCatalog(["openai/gpt-5.6-sol", "anthropic/claude-opus-5"]);
    assert.equal(applied.current.source, "runtime");
    assert.equal(applied.current.models, 2);
    assert.equal(applied.versions.length, 1);

    // runtime overlay becomes visible through the built-in library API
    configureLibraryOverlay(join(dir, "builtin-library"));
    const refs = listBuiltinReferences();
    assert.equal(refs.length, 2);
    assert.equal(refs[0].id, "builtin:pamela:anthropic/claude-opus-5");
    const full = getBuiltinReference("builtin:pamela:openai/gpt-5.6-sol");
    assert.equal(Object.keys(full!.fingerprint.cells).length, 40);
    assert.ok(Object.values(full!.fingerprint.cells).every((cell) => cell.nValid >= 10));

    // direct replacement: applying one model replaces the whole library, rollback restores
    const replaced = manager.updateFromCatalog(["openai/gpt-5.6-sol"]);
    assert.equal(replaced.current.models, 1);
    assert.equal(replaced.versions.length, 2);
    const rolledBack = manager.rollback();
    assert.equal(rolledBack.current.models, 2);
    assert.equal(rolledBack.versions.length, 2);

    // clean cache frees the dataset download
    const cleaned = manager.cleanCache();
    assert.ok(cleaned.freedBytes > 0);
    assert.equal(manager.status().cacheBytes, 0);
  } finally {
    configureLibraryOverlay(undefined);
    await (mock as any).closeMock();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Zenodo update: incompatible prompt hash is refused", async () => {
  const mock = await startMock();
  mock.manifest = { ...GOOD_MANIFEST, prompts_sha256: "f".repeat(64) };
  mock.zip = datasetZip(mock.manifest, [["openai/gpt-5.6-sol", 12]]);
  mock.record.files[0].size = mock.zip.length;
  const dir = await mkdtemp(join(tmpdir(), "mv-zenodo-bad-"));
  const manager = makeManager(dir, mock);
  try {
    await manager.check(true);
    manager.prepare();
    const prepared = await waitJob(manager);
    assert.equal(prepared.prepareJob?.status, "failed");
    assert.match(prepared.prepareJob?.error ?? "", /prompt/i);
    assert.equal(prepared.catalog.ready, false);
  } finally {
    await (mock as any).closeMock();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Zenodo update: apply requires a prepared catalog and at least one model", async () => {
  const mock = await startMock();
  mock.zip = datasetZip(GOOD_MANIFEST, [["openai/gpt-5.6-sol", 12]]);
  const dir = await mkdtemp(join(tmpdir(), "mv-zenodo-empty-"));
  const manager = makeManager(dir, mock);
  try {
    await manager.check(true);
    assert.throws(() => manager.updateFromCatalog(["openai/gpt-5.6-sol"]), /尚未准备|prepare/i);
    manager.prepare();
    const prepared = await waitJob(manager);
    assert.equal(prepared.prepareJob?.status, "done", prepared.prepareJob?.error ?? "prepare failed");
    assert.throws(() => manager.updateFromCatalog([]), /至少一个模型/);
    assert.throws(() => manager.updateFromCatalog(["not/in-catalog"]), /不在已准备/i);
  } finally {
    await (mock as any).closeMock();
    await rm(dir, { recursive: true, force: true });
  }
});

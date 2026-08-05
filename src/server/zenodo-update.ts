import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { Agent, ProxyAgent } from "undici";
import { open as openZip, type Entry, type ZipFile } from "yauzl";
import { isPrivateAddress } from "../core/adapters/types.js";
import { PAMELA_BATTERY } from "../core/battery/pamela.js";
import {
  ZENODO_BATTERY,
  ZENODO_LANGUAGES,
  ZENODO_MIN_VALID_PER_CELL,
  ZENODO_NORMALIZE,
  ZENODO_SYSTEM_PROMPT,
  buildLibrary,
  libraryHealth,
  qualifyModel,
  scanRows,
  type AccumCell,
  type BuiltinLibraryV2,
} from "../core/v2/zenodo-library.js";
import { invalidateLibraryCache } from "./builtin-library.js";

/**
 * Runtime built-in reference library updates straight from Zenodo.
 *
 * - check:  query the latest dataset record for the PAMELA concept DOI.
 * - prepare: download the dataset once (capped cache), verify prompt
 *   compatibility, scan normalized.jsonl into a per-model catalog.
 * - update:  apply the user-selected qualified models as a new versioned
 *   runtime library (direct replacement + rollback support).
 *
 * Network is Zenodo-only (SSRF-checked each hop). Proxy is opt-in via
 * MODEL_VERITY_ZENODO_PROXY (default: direct).
 */

export const ZENODO_CONCEPT_ID = "21278557"; // dataset DOI 10.5281/zenodo.21278557
export const ZENODO_API_BASE = "https://zenodo.org/api/records";
// sha256 of src/core/battery/pamela-prompts.json. The manifest's
// prompts_sha256 must equal this or the update is refused (battery mismatch
// would break cross-dataset comparability). Guarded by a test.
export const EXPECTED_PAMELA_PROMPTS_SHA256 = "32f4fc3ab5077438f362bb4d0c06d1ebbe2bb5d2e0809474045dcd60a6b592c1";
export const DOWNLOAD_CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const MAX_DATASET_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
export const CHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_VERSION_KEEP = 3;

export class ZenodoUpdateError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterMs?: number) {
    super(message);
  }
}

export interface ZenodoRecordFile { key: string; size: number; checksum?: string; links?: { self?: string } }
export interface ZenodoRecord {
  id: number;
  conceptrecid: number;
  updated: string;
  metadata: { version?: string; title?: string; publication_date?: string };
  files?: ZenodoRecordFile[];
}

export interface DownloadManifest { run_id?: string; prompts_sha256?: string; run_config_sha256?: string; created_utc?: string }

export interface DownloadMeta {
  recordId: string;
  version?: string;
  updated: string;
  downloadedAt: string;
  zipBytes: number;
  manifest?: DownloadManifest;
  normalizedSha256?: string;
  scannedRows?: number;
  catalogBuiltAt?: string;
}

export interface CatalogModelInfo {
  model: string;
  qualified: boolean;
  nValid: number;
  missingCells: number;
  belowMinimumCells: number;
}

export interface LibraryVersionMeta {
  file: string;
  libraryVersion: string;
  appliedAt: string;
  zenodo: { recordId: string; version?: string; updated: string };
  modelIds: string[];
}

interface LibraryIndex { currentFile: string | null; versions: LibraryVersionMeta[] }
interface ZenodoState { lastSeen?: { recordId: string; version?: string; updated: string }; lastCheckedAt?: string; lastError?: string }

export type PrepareStage = "download" | "extract" | "scan" | "done";
export interface ZenodoUpdateJob {
  id: string;
  kind: "prepare";
  status: "queued" | "running" | "done" | "failed" | "canceled";
  stage: PrepareStage;
  progress: number; // 0..100
  message: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ZenodoUpdateStatus {
  current: { libraryVersion: string; models: number; collectedAt: string; source: "bundled" | "runtime"; recordId?: string };
  latest: { recordId: string; version?: string; updated: string } | null;
  updateAvailable: boolean;
  catalog: { recordId?: string; ready: boolean; builtAt?: string; models: CatalogModelInfo[]; total: number; qualified: number };
  prepareJob: ZenodoUpdateJob | null;
  checkedAt?: string;
  lastError?: string;
  cacheBytes: number;
  versions: { file: string; appliedAt: string; libraryVersion: string; modelIds: number }[];
}

export interface ZenodoUpdateOptions {
  dataDir: string;
  fetchImpl?: typeof fetch;
  /** Test seam: replace the SSRF/allowlist host check (default: real DNS check). */
  hostCheck?: (rawUrl: string) => Promise<void>;
}

type FetchInit = RequestInit & { dispatcher?: ProxyAgent };

export class ZenodoUpdateManager {
  private readonly dir: string;
  private readonly downloadsDir: string;
  private readonly stateFile: string;
  private readonly indexFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly proxyAgent: ProxyAgent | null;
  private readonly agent: Agent;
  private readonly hostCheck: (rawUrl: string) => Promise<void>;
  private job: ZenodoUpdateJob | null = null;
  private controller: AbortController | null = null;

  constructor(options: ZenodoUpdateOptions) {
    this.dir = join(options.dataDir, "builtin-library");
    this.downloadsDir = join(this.dir, "downloads");
    this.stateFile = join(this.dir, "zenodo-state.json");
    this.indexFile = join(this.dir, "library-index.json");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.hostCheck = options.hostCheck ?? ((rawUrl) => this.assertPublicHost(rawUrl));
    const proxyUrl = process.env.MODEL_VERITY_ZENODO_PROXY?.trim();
    this.proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
    // Direct mode uses a dedicated agent with generous timeouts: large dataset
    // downloads from slow cross-border links routinely exceed undici's 300s default bodyTimeout.
    this.agent = new Agent({ headersTimeout: 120_000, bodyTimeout: 0, connectTimeout: 30_000 });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  // ---------- persistence helpers ----------

  private state(): ZenodoState {
    try { return JSON.parse(readFileSync(this.stateFile, "utf8")) as ZenodoState; } catch { return {}; }
  }
  private writeState(state: ZenodoState): void { writeFileSync(this.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 }); }
  private index(): LibraryIndex {
    try { return JSON.parse(readFileSync(this.indexFile, "utf8")) as LibraryIndex; } catch { return { currentFile: null, versions: [] }; }
  }
  private writeIndex(index: LibraryIndex): void { writeFileSync(this.indexFile, JSON.stringify(index, null, 2), { mode: 0o600 }); }
  private metaPath(recordId: string): string { return join(this.downloadsDir, `${recordId}.meta.json`); }
  private zipPath(recordId: string): string { return join(this.downloadsDir, `${recordId}.zip`); }
  private catalogPath(recordId: string): string { return join(this.downloadsDir, `${recordId}.catalog.json`); }
  private readMeta(recordId: string): DownloadMeta | null {
    try { return JSON.parse(readFileSync(this.metaPath(recordId), "utf8")) as DownloadMeta; } catch { return null; }
  }
  private cacheBytes(): number {
    if (!existsSync(this.downloadsDir)) return 0;
    let total = 0;
    for (const name of readdirSync(this.downloadsDir)) {
      try { total += statSync(join(this.downloadsDir, name)).size; } catch { /* ignore */ }
    }
    return total;
  }
  private pruneCache(keepZip: string): void {
    // Delete oldest cache files (by mtime) until under the 2 GiB limit.
    if (this.cacheBytes() <= DOWNLOAD_CACHE_LIMIT_BYTES) return;
    const entries = readdirSync(this.downloadsDir)
      .map((name) => ({ name, mtime: statSync(join(this.downloadsDir, name)).mtimeMs }))
      .filter((entry) => entry.name !== basename(keepZip))
      .sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      rmSync(join(this.downloadsDir, entry.name), { recursive: true, force: true });
      if (this.cacheBytes() <= DOWNLOAD_CACHE_LIMIT_BYTES) return;
    }
  }

  // ---------- network ----------

  private async fetchZenodo(rawUrl: string, init: FetchInit = {}): Promise<Response> {
    let url = rawUrl;
    for (let hop = 0; hop < 4; hop += 1) {
      await this.hostCheck(url);
      const response = await this.fetchImpl(url, { ...init, redirect: "manual", ...(this.proxyAgent ? { dispatcher: this.proxyAgent } : { dispatcher: this.agent }) } as unknown as RequestInit);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel?.().catch(() => undefined);
        url = new URL(location, url).toString();
        continue;
      }
      return response;
    }
    throw new ZenodoUpdateError(502, "Zenodo redirect loop");
  }

  private async assertPublicHost(raw: string): Promise<void> {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new ZenodoUpdateError(502, "invalid Zenodo URL"); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new ZenodoUpdateError(502, "Zenodo URLs must use http(s)");
    if (parsed.username || parsed.password) throw new ZenodoUpdateError(502, "Zenodo URL userinfo is not allowed");
    const addresses = isIP(parsed.hostname) ? [{ address: parsed.hostname }] : await lookup(parsed.hostname, { all: true, verbatim: true });
    if (addresses.some(({ address }) => isPrivateAddress(address)) && process.env.MODEL_VERITY_ALLOW_PRIVATE_ENDPOINTS !== "1") {
      throw new ZenodoUpdateError(502, "Zenodo endpoint resolved to a private address (SSRF policy)");
    }
  }

  private async fetchJson(rawUrl: string, signal?: AbortSignal): Promise<any> {
    const response = await this.fetchZenodo(rawUrl, { headers: { accept: "application/json" }, signal });
    const text = await response.text();
    if (!response.ok) throw new ZenodoUpdateError(502, `Zenodo returned HTTP ${response.status}`);
    try { return JSON.parse(text); } catch { throw new ZenodoUpdateError(502, "Zenodo returned invalid JSON"); }
  }

  private async downloadToFile(
    rawUrl: string,
    dest: string,
    capBytes: number,
    signal?: AbortSignal,
    onProgress?: (bytes: number, total: number) => void,
  ): Promise<number> {
    const response = await this.fetchZenodo(rawUrl, { signal });
    if (!response.ok) throw new ZenodoUpdateError(502, `Zenodo download returned HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length") ?? 0);
    if (total > capBytes) throw new ZenodoUpdateError(413, `dataset too large (${total} bytes > ${capBytes})`);
    const out = createWriteStream(dest, { mode: 0o600 });
    let bytes = 0;
    let lastReport = 0;
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        if (signal?.aborted) throw new ZenodoUpdateError(409, "canceled");
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > capBytes) { out.destroy(new Error("size cap exceeded")); throw new ZenodoUpdateError(413, `dataset exceeds ${capBytes} bytes`); }
        await new Promise<void>((resolve, reject) => out.write(value, (error: Error | null | undefined) => (error ? reject(error) : resolve())));
        if (onProgress && bytes - lastReport >= 1024 * 1024) { lastReport = bytes; onProgress(bytes, total); }
      }
      await new Promise<void>((resolve, reject) => out.end((error: Error | null | undefined) => (error ? reject(error) : resolve())));
      if (onProgress) onProgress(bytes, total);
    } catch (error) {
      out.destroy();
      rmSync(dest, { force: true });
      throw error;
    }
    return bytes;
  }

  // ---------- zip ----------

  private withZip<T>(zipPath: string, fn: (zip: ZipFile) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      openZip(zipPath, { lazyEntries: true, autoClose: true }, (error, zip) => {
        if (error || !zip) { reject(error ?? new Error("cannot open zip")); return; }
        fn(zip).then(resolve, reject);
      });
    });
  }

  /** Streams the first entry whose basename matches. Returns null when absent. */
  private entryStream(zip: ZipFile, basenameMatch: string): Promise<{ name: string; stream: NodeJS.ReadableStream } | null> {
    return new Promise((resolve, reject) => {
      let settled = false;
      zip.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
      zip.on("entry", (entry: Entry) => {
        if (basename(entry.fileName).toLowerCase() === basenameMatch) {
          zip.openReadStream(entry, (error, stream) => {
            if (error) { if (!settled) { settled = true; reject(error); } return; }
            if (!settled) { settled = true; resolve({ name: entry.fileName, stream }); }
          });
          return;
        }
        zip.readEntry();
      });
      zip.on("end", () => { if (!settled) { settled = true; resolve(null); } });
      zip.readEntry();
    });
  }

  private async collectEntry(zip: ZipFile, basenameMatch: string, capBytes: number): Promise<Buffer | null> {
    const found = await this.entryStream(zip, basenameMatch);
    if (!found) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of found.stream) {
      size += (chunk as Buffer).byteLength;
      if (size > capBytes) throw new ZenodoUpdateError(413, `entry ${basenameMatch} too large`);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  // ---------- check / status ----------

  private async withRetry<T>(
    operation: (attempt: number) => Promise<T>,
    retries: number,
    onRetry?: (attempt: number, error: unknown) => void,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        if (attempt >= retries || this.controller?.signal?.aborted) throw error;
        const retryable = error instanceof ZenodoUpdateError ? [502, 503, 504].includes(error.status) : true;
        if (!retryable) throw error;
        onRetry?.(attempt, error);
        await sleep(Math.min(10_000, 2000 * 2 ** attempt), this.controller?.signal);
      }
    }
  }

  async check(refresh: boolean): Promise<ZenodoUpdateStatus> {
    const now = Date.now();
    const state = this.state();
    if (!refresh && state.lastCheckedAt && now - Date.parse(state.lastCheckedAt) < CHECK_MIN_INTERVAL_MS) {
      return this.status();
    }
    try {
      const record = await this.withRetry(
        () => this.fetchJson(`${ZENODO_API_BASE}/${ZENODO_CONCEPT_ID}`) as Promise<ZenodoRecord>,
        3,
      );
      const lastSeen = { recordId: String(record.id), version: record.metadata.version, updated: record.updated };
      this.writeState({ ...state, lastSeen, lastCheckedAt: new Date(now).toISOString(), lastError: undefined });
    } catch (error) {
      this.writeState({ ...state, lastError: error instanceof Error ? error.message : String(error) });
      throw error instanceof ZenodoUpdateError ? error : new ZenodoUpdateError(502, error instanceof Error ? error.message : String(error));
    }
    return this.status();
  }

  status(): ZenodoUpdateStatus {
    const state = this.state();
    const index = this.index();
    const runtime = index.currentFile ? index.versions.find((version) => version.file === index.currentFile) : undefined;
    const currentMeta = this.currentLibrarySummary();
    const latest = state.lastSeen ? { recordId: state.lastSeen.recordId, version: state.lastSeen.version, updated: state.lastSeen.updated } : null;
    const catalog = state.lastSeen ? this.catalogSummary(state.lastSeen.recordId) : { ready: false, models: [], total: 0, qualified: 0 };
    const updateAvailable = Boolean(
      state.lastSeen && (runtime ? runtime.zenodo.recordId !== state.lastSeen.recordId : true),
    );
    return {
      current: currentMeta,
      latest,
      updateAvailable,
      catalog: { ...catalog, recordId: state.lastSeen?.recordId },
      prepareJob: this.job ? { ...this.job } : null,
      checkedAt: state.lastCheckedAt,
      lastError: state.lastError,
      cacheBytes: this.cacheBytes(),
      versions: index.versions.map((version) => ({ file: version.file, appliedAt: version.appliedAt, libraryVersion: version.libraryVersion, modelIds: version.modelIds.length })),
    };
  }

  private currentLibrarySummary(): ZenodoUpdateStatus["current"] {
    const index = this.index();
    const runtime = index.currentFile ? index.versions.find((version) => version.file === index.currentFile) : undefined;
    if (runtime) {
      const library = this.readVersion(runtime.file);
      return {
        libraryVersion: runtime.libraryVersion,
        models: library ? library.models.length : 0,
        collectedAt: runtime.zenodo.updated,
        source: "runtime",
        recordId: runtime.zenodo.recordId,
      };
    }
    try {
      const bundledPath = join(import.meta.dirname, "../data/builtin-fingerprints.json.gz");
      const bundled = JSON.parse(gunzipSync(readFileSync(bundledPath)).toString("utf8"));
      return { libraryVersion: bundled.libraryVersion, models: bundled.models.length, collectedAt: bundled.source.collectedAt, source: "bundled" };
    } catch {
      return { libraryVersion: "unknown", models: 0, collectedAt: "", source: "bundled" };
    }
  }

  private catalogSummary(recordId: string): { ready: boolean; builtAt?: string; models: CatalogModelInfo[]; total: number; qualified: number } {
    const catalog = this.readCatalog(recordId);
    if (!catalog) return { ready: false, models: [], total: 0, qualified: 0 };
    const models = Object.entries(catalog.byModel)
      .map(([model, cells]) => {
        const q = qualifyModel(model, new Map(Object.entries(cells)), this.expectedCellIds());
        return { model, qualified: q.qualified, nValid: q.nValid, missingCells: q.missingCells.length, belowMinimumCells: q.belowMinimumCells.length };
      })
      .sort((a, b) => a.model.localeCompare(b.model));
    return { ready: true, builtAt: catalog.builtAt, models, total: models.length, qualified: models.filter((m) => m.qualified).length };
  }

  private readCatalog(recordId: string): { recordId: string; builtAt: string; byModel: Record<string, Record<string, AccumCell>> } | null {
    try { return JSON.parse(readFileSync(this.catalogPath(recordId), "utf8")); } catch { return null; }
  }

  private expectedCellIds(): string[] {
    return PAMELA_BATTERY.map((cell) => cell.id);
  }

  // ---------- prepare (download + scan) ----------

  prepare(): ZenodoUpdateJob {
    if (this.job && (this.job.status === "queued" || this.job.status === "running")) {
      throw new ZenodoUpdateError(409, "another Zenodo update task is active");
    }
    const state = this.state();
    if (!state.lastSeen) throw new ZenodoUpdateError(400, "run the update check first");
    this.controller = new AbortController();
    this.job = {
      id: `zenodo-prepare-${Date.now().toString(36)}`,
      kind: "prepare",
      status: "queued",
      stage: "download",
      progress: 0,
      message: "准备中",
      startedAt: new Date().toISOString(),
    };
    void this.runPrepare(state.lastSeen);
    return { ...this.job };
  }

  cancelPrepare(): void {
    if (this.job && (this.job.status === "queued" || this.job.status === "running")) {
      this.controller?.abort();
      this.job.status = "canceled";
      this.job.finishedAt = new Date().toISOString();
      this.job.message = "已取消";
    }
  }

  jobFor(id: string): ZenodoUpdateJob | null {
    return this.job && this.job.id === id ? { ...this.job } : null;
  }

  private setJob(patch: Partial<ZenodoUpdateJob>): void {
    if (this.job) Object.assign(this.job, patch);
  }

  private async runPrepare(lastSeen: { recordId: string; version?: string; updated: string }): Promise<void> {
    const recordId = lastSeen.recordId;
    try {
      const signal = this.controller?.signal;
      this.setJob({ status: "running", stage: "download", progress: 5, message: "下载数据集（首次需要数百 MB，仅下载一次）" });
      const zipPath = this.zipPath(recordId);
      let zipBytes = existsSync(zipPath) ? statSync(zipPath).size : 0;
      if (!existsSync(zipPath)) {
        const record = await this.withRetry(
          () => this.fetchJson(`${ZENODO_API_BASE}/${ZENODO_CONCEPT_ID}`, signal) as Promise<ZenodoRecord>,
          3,
          (attempt) => this.setJob({ progress: 5, message: `获取数据集信息失败，第 ${attempt + 1} 次重试…` }),
        );
        const target = record.files?.find((file) => file.key.toLowerCase().endsWith(".zip"));
        if (!target?.links?.self) throw new ZenodoUpdateError(502, "dataset zip file not found in Zenodo record");
        const recordZipUrl = target.links!.self;
        mkdirSync(this.downloadsDir, { recursive: true, mode: 0o700 });
        const tmp = `${zipPath}.part`;
        zipBytes = await this.withRetry(
          () =>
            this.downloadToFile(recordZipUrl, tmp, MAX_DATASET_ZIP_BYTES, signal, (bytes, total) => {
              const percent = total ? Math.min(40, 5 + Math.floor((bytes / total) * 35)) : 5;
              this.setJob({
                progress: percent,
                message: total
                  ? `下载中 ${(bytes / (1024 * 1024)).toFixed(0)} / ${(total / (1024 * 1024)).toFixed(0)} MB`
                  : "下载中…",
              });
            }),
          2,
          (attempt) => this.setJob({ progress: 5, message: `下载失败（Zenodo 响应慢），第 ${attempt + 1} 次重试…` }),
        );
        if (signal?.aborted) { rmSync(tmp, { force: true }); throw new ZenodoUpdateError(409, "canceled"); }
        rmSync(zipPath, { force: true });
        renameSync(tmp, zipPath);
      }
      if (signal?.aborted) throw new ZenodoUpdateError(409, "canceled");
      this.setJob({ stage: "extract", progress: 45, message: "校验数据集与 prompt 一致性" });
      const meta = this.readMeta(recordId) ?? { recordId, version: lastSeen.version, updated: lastSeen.updated, downloadedAt: new Date().toISOString(), zipBytes };
      const { manifest } = await this.withZip(zipPath, async (zip) => {
        const manifestBytes = await this.collectEntry(zip, "manifest.json", 1024 * 1024);
        return {
          manifest: manifestBytes ? (JSON.parse(manifestBytes.toString("utf8")) as DownloadManifest) : undefined,
        };
      });
      if (!manifest?.prompts_sha256) throw new ZenodoUpdateError(422, "新数据集缺少 manifest.json 或 prompts_sha256");
      if (manifest.prompts_sha256 !== EXPECTED_PAMELA_PROMPTS_SHA256) {
        throw new ZenodoUpdateError(422, "新数据集的 prompt 与当前电池不一致，已拒绝更新（避免跨 prompt 不可比）");
      }
      const runIds = new Set(manifest.run_id ? [manifest.run_id, "main-02"] : ["main-02"]);
      this.setJob({ stage: "scan", progress: 55, message: "扫描 normalized.jsonl 聚合各模型指纹（一次性）" });
      const byModel = new Map<string, Map<string, AccumCell>>();
      const hash = createHash("sha256");
      let scanned = 0;
      let foundNormalized = false;
      await this.withZip(zipPath, async (zip) => {
        for (;;) {
          const found = await this.entryStream(zip, "normalized.jsonl");
          if (!found) break;
          foundNormalized = true;
          const lines = createInterface({ input: found.stream as NodeJS.ReadableStream, crlfDelay: Infinity });
          for await (const line of lines) {
            if (!line) continue;
            scanned += 1;
            hash.update(String(line)).update("\n");
            if (signal?.aborted) throw new ZenodoUpdateError(409, "canceled");
            const row = JSON.parse(line);
            scanRows([row], { runIds, tasks: new Set(this.expectedCellIds().map((id) => id.split(":")[1])), languages: ZENODO_LANGUAGES }).forEach((cells, model) => {
              const existing = byModel.get(model);
              if (existing) for (const [id, cell] of cells) {
                const acc = existing.get(id) ?? { counts: {}, nValid: 0, nInvalid: 0, nRefusal: 0, nEmpty: 0, nError: 0 };
                acc.counts = mergeCounts(acc.counts, cell.counts);
                acc.nValid += cell.nValid; acc.nInvalid += cell.nInvalid; acc.nRefusal += cell.nRefusal; acc.nEmpty += cell.nEmpty; acc.nError += cell.nError;
                existing.set(id, acc);
              }
              else byModel.set(model, cells);
            });
            if (scanned % 20000 === 0) this.setJob({ progress: Math.min(92, 55 + Math.floor((scanned / 400000) * 35)) });
          }
          break; // only one normalized.jsonl expected; stop after first match
        }
      });
      if (!foundNormalized) throw new ZenodoUpdateError(422, "数据集内未找到 normalized.jsonl");
      if (scanned === 0) throw new ZenodoUpdateError(422, `数据集内没有 run_id=${[...runIds].join(",")} 的记录`);
      const catalog: Record<string, Record<string, AccumCell>> = {};
      for (const [model, cells] of byModel) catalog[model] = Object.fromEntries(cells);
      const catalogJson = JSON.stringify({ recordId, builtAt: new Date().toISOString(), byModel: catalog });
      writeFileSync(this.catalogPath(recordId), catalogJson, { mode: 0o600 });
      this.writeMeta({ ...meta, manifest, normalizedSha256: hash.digest("hex"), scannedRows: scanned, catalogBuiltAt: new Date().toISOString() });
      this.pruneCache(zipPath);
      this.setJob({ status: "done", stage: "done", progress: 100, message: `已准备 ${byModel.size} 个模型`, finishedAt: new Date().toISOString() });
    } catch (error) {
      if (this.job?.status === "canceled") return;
      const message = error instanceof Error ? error.message : String(error);
      this.setJob({ status: "failed", error: message, message: "准备失败", finishedAt: new Date().toISOString() });
    }
  }

  private writeMeta(meta: DownloadMeta): void {
    mkdirSync(this.downloadsDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.metaPath(meta.recordId), JSON.stringify(meta, null, 2), { mode: 0o600 });
  }

  // ---------- apply selected models ----------

  updateFromCatalog(modelIds: string[]): ZenodoUpdateStatus {
    const state = this.state();
    if (!state.lastSeen) throw new ZenodoUpdateError(400, "run the update check first");
    const recordId = state.lastSeen.recordId;
    const meta = this.readMeta(recordId);
    const catalog = this.readCatalog(recordId);
    if (!meta?.manifest || !catalog) throw new ZenodoUpdateError(400, "数据集尚未准备（先执行准备）");
    if (meta.manifest.prompts_sha256 !== EXPECTED_PAMELA_PROMPTS_SHA256) {
      throw new ZenodoUpdateError(422, "数据集 prompt 与当前电池不一致，已拒绝更新");
    }
    const uniqueIds = [...new Set(modelIds.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (!uniqueIds.length) throw new ZenodoUpdateError(400, "请选择至少一个模型");
    const expected = this.expectedCellIds();
    const byModel = new Map<string, Map<string, AccumCell>>();
    for (const model of uniqueIds) {
      const raw = catalog.byModel[model];
      if (!raw) throw new ZenodoUpdateError(400, `模型 ${model} 不在已准备的数据集中`);
      byModel.set(model, new Map(Object.entries(raw)));
    }
    const source = {
      title: "Single-token output distributions as behavioral fingerprints of large language models",
      author: "Tomáš Bruckner",
      datasetDoi: "10.5281/zenodo.21278557",
      datasetLicense: "CC BY 4.0",
      softwareDoi: "10.5281/zenodo.21278793",
      softwareLicense: "MIT",
      runId: meta.manifest.run_id ?? "main-02",
      collectedAt: meta.manifest.created_utc ?? meta.updated,
      provider: "OpenRouter aggregator with recorded upstream routing",
      trustNotice: "Research/community reference; not first-party vendor attestation.",
      promptsSha256: meta.manifest.prompts_sha256,
      runConfigSha256: meta.manifest.run_config_sha256 ?? "",
      normalizedSha256: meta.normalizedSha256 ?? "",
    };
    const libraryVersion = `pamela-zenodo-${meta.version ?? recordId}@1`;
    const library = buildLibrary(byModel, expected, {
      libraryVersion,
      source,
      protocol: {
        batteryVersion: ZENODO_BATTERY,
        normalizeVersion: ZENODO_NORMALIZE,
        systemPromptVersion: ZENODO_SYSTEM_PROMPT,
        temperature: 1,
        maxTokens: 16,
        nominalRepetitions: 30,
        repetitionsNote: "main plan nominally uses 30; expensive models may use 0.5 factor; authoritative per-cell totals are stored in counts and validity fields",
        minValidPerCell: ZENODO_MIN_VALID_PER_CELL,
      },
      ids: uniqueIds,
    });
    const health = libraryHealth(library);
    if (!health.ok) throw new ZenodoUpdateError(422, `新库校验失败：${health.reason}`);
    if (!library.models.length) throw new ZenodoUpdateError(422, "所选模型均未通过 40-cell/有效样本门槛");
    const index = this.index();
    const versionNo = index.versions.length + 1;
    const file = `library-v${versionNo}.json.gz`;
    writeFileSync(join(this.dir, file), gzipSync(Buffer.from(JSON.stringify(library)), { level: 9 }), { mode: 0o600 });
    index.versions.push({
      file,
      libraryVersion,
      appliedAt: new Date().toISOString(),
      zenodo: { recordId, version: meta.version, updated: meta.updated },
      modelIds: library.models.map((model) => model.model),
    });
    // prune to last MAX_VERSION_KEEP versions, never removing the active file
    while (index.versions.length > MAX_VERSION_KEEP) {
      const oldestIdx = index.versions[0]?.file === file ? 1 : 0;
      const removed = index.versions.splice(oldestIdx, 1)[0];
      if (removed) rmSync(join(this.dir, removed.file), { force: true });
    }
    index.currentFile = file;
    this.writeIndex(index);
    invalidateLibraryCache();
    return this.status();
  }

  // ---------- rollback / cleanup ----------

  rollback(): ZenodoUpdateStatus {
    const index = this.index();
    if (index.versions.length <= 1 || !index.currentFile) throw new ZenodoUpdateError(400, "没有可回滚的上一版本");
    const currentIdx = index.versions.findIndex((version) => version.file === index.currentFile);
    if (currentIdx <= 0) throw new ZenodoUpdateError(400, "没有可回滚的上一版本");
    index.currentFile = index.versions[currentIdx - 1].file;
    this.writeIndex(index);
    invalidateLibraryCache();
    return this.status();
  }

  cleanCache(): { ok: boolean; freedBytes: number } {
    const before = this.cacheBytes();
    rmSync(this.downloadsDir, { recursive: true, force: true });
    mkdirSync(this.downloadsDir, { recursive: true, mode: 0o700 });
    return { ok: true, freedBytes: before };
  }

  private readVersion(file: string): BuiltinLibraryV2 | null {
    try { return JSON.parse(gunzipSync(readFileSync(join(this.dir, file))).toString("utf8")) as BuiltinLibraryV2; } catch { return null; }
  }
}

function mergeCounts(left: Record<string, number>, right: Record<string, number>): Record<string, number> {
  for (const [key, value] of Object.entries(right)) left[key] = (left[key] ?? 0) + value;
  return left;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ZenodoUpdateError(409, "canceled")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new ZenodoUpdateError(409, "canceled")); }, { once: true });
  });
}

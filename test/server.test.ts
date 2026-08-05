import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { anthropicMessagesAdapter } from "../src/core/adapters/anthropic.js";
import { openAICompatibleAdapter } from "../src/core/adapters/openai.js";
import { openAIResponsesAdapter } from "../src/core/adapters/openai-responses.js";
import { Repository } from "../src/server/db.js";
import { SecretStore } from "../src/server/secrets.js";
import { builtinLibraryInfo, getBuiltinReference, listBuiltinReferences } from "../src/server/builtin-library.js";

test("encrypted secret fallback round-trips without plaintext on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mv-secret-"));
  process.env.MODEL_VERITY_DISABLE_KEYCHAIN = "1";
  delete process.env.MODEL_VERITY_MASTER_KEY;
  try {
    const store = new SecretStore(dir);
    const reference = await store.set("provider-1", "sk-super-secret-value");
    assert.equal(reference, "file:provider-1");
    assert.equal(await store.get(reference), "sk-super-secret-value");
    const disk = await readFile(join(dir, "secrets", "secrets.enc.json"), "utf8");
    assert.doesNotMatch(disk, /sk-super-secret-value/);
    assert.equal((await stat(join(dir, "secrets", "secrets.enc.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "secrets", "master.key"))).mode & 0o777, 0o600);
    await store.delete(reference);
    assert.equal(await store.get(reference), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("built-in PAMELA library is compact, complete, attributed, and read-only by construction", () => {
  const info = builtinLibraryInfo();
  const references = listBuiltinReferences();
  assert.equal(info.models, 33);
  assert.equal(info.cellsPerModel, 40);
  assert.equal(info.source.datasetDoi, "10.5281/zenodo.21278557");
  assert.equal(info.source.datasetLicense, "CC BY 4.0");
  assert.equal(info.source.promptsSha256, "32f4fc3ab5077438f362bb4d0c06d1ebbe2bb5d2e0809474045dcd60a6b592c1");
  assert.equal(references.length, 33);
  assert.ok(references.every((reference) => reference.readonly && reference.cellIds.length === 40));
  assert.ok(references.every((reference) => !("fingerprint" in reference)));
  const full = getBuiltinReference("builtin:pamela:openai/gpt-5.4-mini");
  assert.equal(full?.modelClaimed, "openai/gpt-5.4-mini");
  assert.ok(Object.values(full!.fingerprint.cells).every((cell) => cell.nValid >= 10));
});

test("SQLite repository persists providers, references, runs and settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mv-db-"));
  try {
    const repo = new Repository(dir);
    const provider = repo.saveProvider({ name: "Mock", protocol: "openai-compatible", baseUrl: "http://localhost", models: ["mock"], role: "either", secretRef: "file:mock", headers: {} });
    assert.equal(repo.listProviders().length, 1);
    const reference = repo.saveReference({ providerId: provider.id, modelClaimed: "mock", label: "Mock · mock", baseUrl: provider.baseUrl, enrolledAt: new Date().toISOString(), batteryVersion: "v", normalizeVersion: "v", systemPromptVersion: "v", cellIds: ["en:coin_flip"], fingerprint: { cells: {} } });
    const run = repo.createRun({ kind: "audit", providerId: provider.id, model: "mock", referenceId: reference.id, profile: "audit" });
    assert.equal(repo.updateRun(run.id, { status: "running", progress: 0.5 }).progress, 0.5);
    const builtinRun = repo.createRun({ kind: "audit", providerId: provider.id, model: "mock", referenceId: "builtin:pamela:openai/gpt-5.4-mini", profile: "audit" });
    assert.equal(builtinRun.referenceId, "builtin:pamela:openai/gpt-5.4-mini");
    assert.deepEqual(repo.saveSettings({ concurrency: 7, tauMatch: 0.1, tauMid: 0.3, retainRaw: true }), { concurrency: 7, tauMatch: 0.1, tauMid: 0.3, retainRaw: true });
    repo.close();
    const reopened = new Repository(dir);
    assert.equal(reopened.getProvider(provider.id)?.name, "Mock");
    assert.equal(reopened.getReference(reference.id)?.cellIds[0], "en:coin_flip");
    assert.equal(reopened.getRun(run.id)?.status, "running");
    assert.equal(reopened.getRun(builtinRun.id)?.referenceId, "builtin:pamela:openai/gpt-5.4-mini");
    reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("repository usage counts preserve history while guarding active dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mv-usage-"));
  try {
    const repo = new Repository(dir);
    const provider = repo.saveProvider({ name: "Mock", protocol: "openai-compatible", baseUrl: "http://localhost", models: ["mock"], role: "either", secretRef: "file:mock", headers: {} });
    const reference = repo.saveReference({ providerId: provider.id, modelClaimed: "mock", label: "Mock", baseUrl: provider.baseUrl, enrolledAt: new Date().toISOString(), batteryVersion: "v", normalizeVersion: "v", systemPromptVersion: "v", cellIds: ["en:coin_flip"], fingerprint: { cells: {} } });
    const completed = repo.createRun({ kind: "audit", providerId: provider.id, model: "mock", referenceId: reference.id, profile: "audit" });
    repo.updateRun(completed.id, { status: "completed" });
    const active = repo.createRun({ kind: "audit", providerId: provider.id, model: "mock", referenceId: reference.id, profile: "audit" });
    assert.deepEqual(repo.providerUsage(provider.id), { references: 1, activeRuns: 1, historyRuns: 2 });
    assert.deepEqual(repo.referenceUsage(reference.id), { activeRuns: 1, historyRuns: 2 });
    repo.updateRun(active.id, { status: "cancelled" });
    assert.deepEqual(repo.referenceUsage(reference.id), { activeRuns: 0, historyRuns: 2 });
    repo.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("repository marks interrupted runs failed on startup recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mv-recover-"));
  try {
    const repo = new Repository(dir);
    const provider = repo.saveProvider({ name: "Mock", protocol: "openai-compatible", baseUrl: "http://localhost", models: ["mock"], role: "either", secretRef: "file:mock", headers: {} });
    const run = repo.createRun({ kind: "enroll", providerId: provider.id, model: "mock", profile: "enroll" });
    repo.updateRun(run.id, { status: "running" });
    assert.equal(repo.recoverInterruptedRuns(), 1);
    assert.equal(repo.getRun(run.id)?.status, "failed");
    repo.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider adapters block private endpoints unless local policy explicitly permits them", async()=>{
 const old=process.env.MODEL_VERITY_ALLOW_PRIVATE_ENDPOINTS;delete process.env.MODEL_VERITY_ALLOW_PRIVATE_ENDPOINTS;try{await assert.rejects(()=>openAICompatibleAdapter.listModels({baseUrl:"http://127.0.0.1:9/v1",apiKey:"x",timeoutMs:20}),/private provider endpoint blocked/);}finally{if(old==null)delete process.env.MODEL_VERITY_ALLOW_PRIVATE_ENDPOINTS;else process.env.MODEL_VERITY_ALLOW_PRIVATE_ENDPOINTS=old;}
});

test("OpenAI adapter retries without unsupported reasoning controls and marks degradation", async () => {
  let calls = 0;
  const mock = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls += 1; res.setHeader("content-type", "application/json");
    if (body.reasoning_effort) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: "unknown field reasoning_effort" } })); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: "Blue" } }] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await openAICompatibleAdapter.complete({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", model: "x", system: "x", user: "x", temperature: 1, maxTokens: 16, disableReasoning: true });
    assert.equal(response.text, "Blue"); assert.equal(response.reasoningDisabled, false); assert.equal(calls, 2);
  } finally { await new Promise<void>((resolve) => mock.close(() => resolve())); }
});

test("OpenAI Responses adapter maps request, output_text, usage and reasoning status", async () => {
  const received: any[] = [];
  const mock = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "resp_1", model: "gpt-response", output: [{ type: "message", content: [{ type: "output_text", text: "Blue" }] }], usage: { input_tokens: 5, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } } }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await openAIResponsesAdapter.complete({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "secret", model: "gpt-response", system: "one word", user: "color", temperature: 1, maxTokens: 16, disableReasoning: true });
    assert.equal(received[0].url, "/v1/responses");
    assert.equal(received[0].headers.authorization, "Bearer secret");
    assert.deepEqual(received[0].body, { model: "gpt-response", instructions: "one word", input: "color", temperature: 1, max_output_tokens: 16, stream: false, store: false, reasoning: { effort: "none" } });
    assert.equal(response.text, "Blue");
    assert.equal(response.responseModel, "gpt-response");
    assert.deepEqual(response.usage, { inputTokens: 5, outputTokens: 1 });
    assert.equal(response.reasoningDisabled, true);
  } finally { await new Promise<void>((resolve) => mock.close(() => resolve())); }
});

test("OpenAI Responses adapter retries without unsupported reasoning control and marks degradation", async () => {
  let calls = 0;
  const mock = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); calls += 1; res.setHeader("content-type", "application/json");
    if (request.reasoning) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: "unsupported reasoning effort" } })); return; }
    res.end(JSON.stringify({ model: "gpt-response", output_text: "OK", usage: { input_tokens: 2, output_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await openAIResponsesAdapter.complete({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "secret", model: "gpt-response", system: "x", user: "x", temperature: 0, maxTokens: 8, disableReasoning: true });
    assert.equal(response.text, "OK");
    assert.equal(response.reasoningDisabled, false);
    assert.equal(calls, 2);
  } finally { await new Promise<void>((resolve) => mock.close(() => resolve())); }
});

test("adapters list model IDs from OpenAI and Anthropic model endpoints", async () => {
  const received: Array<{ url?: string; headers: Record<string, unknown> }> = [];
  const mock = createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    res.setHeader("content-type", "application/json");
    if (req.url === "/openai/v1/models") res.end(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }] }));
    else res.end(JSON.stringify({ data: [{ id: "claude-fable-5" }, { id: "claude-sonnet-5" }] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); const port = typeof address === "object" && address ? address.port : 0;
  try {
    const openai = await openAICompatibleAdapter.listModels({ baseUrl: `http://127.0.0.1:${port}/openai/v1`, apiKey: "openai-secret" });
    const anthropic = await anthropicMessagesAdapter.listModels({ baseUrl: `http://127.0.0.1:${port}/anthropic/v1`, apiKey: "anthropic-secret" });
    assert.deepEqual(openai, ["a-model", "z-model"]);
    assert.deepEqual(anthropic, ["claude-fable-5", "claude-sonnet-5"]);
    assert.equal(received[0].headers.authorization, "Bearer openai-secret");
    assert.equal(received[1].headers["x-api-key"], "anthropic-secret");
    assert.equal(received[1].headers["anthropic-version"], "2023-06-01");
  } finally { await new Promise<void>((resolve) => mock.close(() => resolve())); }
});

test("OpenAI and Anthropic adapters map requests and visible responses", async () => {
  const received: any[] = [];
  const mock = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/chat/completions") res.end(JSON.stringify({ model: "mock-openai", choices: [{ message: { content: "Blue" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    else res.end(JSON.stringify({ model: "mock-anthropic", content: [{ type: "text", text: "Heads" }], usage: { input_tokens: 3, output_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); const port = typeof address === "object" && address ? address.port : 0;
  const common = { apiKey: "secret", model: "mock", system: "one word", user: "color", temperature: 1, maxTokens: 16, disableReasoning: true };
  try {
    const openai = await openAICompatibleAdapter.complete({ ...common, baseUrl: `http://127.0.0.1:${port}/v1` });
    const anthropic = await anthropicMessagesAdapter.complete({ ...common, baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(openai.text, "Blue"); assert.equal(anthropic.text, "Heads");
    assert.deepEqual(received[0].body.reasoning, { enabled: false });
    assert.equal(received[0].body.reasoning_effort, "none");
    assert.equal(received[0].body.enable_thinking, false);
    assert.equal(received[0].headers.authorization, "Bearer secret");
    assert.equal(received[1].headers["x-api-key"], "secret");
  } finally { await new Promise<void>((resolve) => mock.close(() => resolve())); }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "../src/server/index.js";
import { PAMELA_BATTERY, pamelaSystemPrompt } from "../src/core/battery/pamela.js";

async function json(url: string, path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${url}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const payload = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}
async function waitRun(url: string, id: string): Promise<any> {
  for (let i = 0; i < 300; i += 1) {
    const run = await json(url, `/api/runs/${id}`);
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run timeout");
}
async function waitConnectionTest(url: string, id: string): Promise<any> {
  for (let i = 0; i < 100; i += 1) {
    const session = await json(url, `/api/connection-tests/${id}`);
    if (session.status !== "running") return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("connection test timeout");
}
async function waitV2Run(url:string,id:string):Promise<any>{
  for(let i=0;i<300;i+=1){const run=await json(url,`/api/v2/verification-runs/${id}`);if(!["queued","running"].includes(run.status))return run;await new Promise((resolve)=>setTimeout(resolve,20));}
  throw new Error("v2 run timeout");
}

test("HTTP built-in reference audit runs without enrollment and preserves research attribution", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mv-builtin-e2e-"));
  process.env.MODEL_VERITY_DISABLE_KEYCHAIN = "1";
  process.env.MODEL_VERITY_MASTER_KEY = "builtin-e2e-key";
  const seenSystems = new Set<string>();
  const seenPrompts = new Set<string>();
  const mock = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const messages = body.messages ?? [];
    seenSystems.add(messages.find((message: any) => message.role === "system")?.content ?? "");
    const prompt = messages.find((message: any) => message.role === "user")?.content ?? "";
    seenPrompts.add(prompt);
    const content = /coin|монет|硬币|نقود/i.test(prompt) ? "heads" : /color|цвет|颜色|لون/i.test(prompt) ? "blue" : /number|число|数字|رقم/i.test(prompt) ? "7" : /letter|букв|汉字|حرف/i.test(prompt) ? "a" : "cat";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "third-party-mock", choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); const port = typeof address === "object" && address ? address.port : 0;
  const app = await startServer({ port: 0, dataDir, webRoot: join(process.cwd(), "dist/web") });
  try {
    const references = await json(app.state.url, "/api/references");
    assert.equal(references.items.length, 33);
    assert.equal(references.library.models, 33);
    const reference = references.items.find((item: any) => item.id === "builtin:pamela:openai/gpt-5.4-mini");
    assert.equal(reference.sourceType, "builtin-research");
    assert.equal(reference.readonly, true);
    const denied = await fetch(`${app.state.url}/api/references/${encodeURIComponent(reference.id)}`, { method: "DELETE" });
    assert.equal(denied.status, 409);
    const provider = await json(app.state.url, "/api/providers", { method: "POST", body: JSON.stringify({ name: "Third-party Mock", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "secret", models: ["openai/gpt-4o-mini"], role: "audit" }) });
    const audit = await json(app.state.url, "/api/audits", { method: "POST", body: JSON.stringify({ providerId: provider.id, model: "openai/gpt-4o-mini", claimedModel: "openai/gpt-4o-mini", referenceId: reference.id, profile: "quick" }) });
    const audited = await waitRun(app.state.url, audit.id);
    assert.ok(["completed", "failed"].includes(audited.status));
    assert.equal(audited.result.reference.sourceType, "builtin-research");
    assert.equal(audited.result.reference.datasetDoi, "10.5281/zenodo.21278557");
    assert.match(audited.result.protocolNote, /OpenRouter 研究快照|协议降级/);
    const exactPrompts = new Set(PAMELA_BATTERY.map((cell) => cell.prompt));
    const exactSystems = new Set(["en", "ru", "zh", "ar"].map((language) => pamelaSystemPrompt(language as "en" | "ru" | "zh" | "ar")));
    assert.equal(seenPrompts.size, 4);
    assert.ok([...seenPrompts].every((prompt) => exactPrompts.has(prompt)));
    assert.ok([...seenSystems].every((system) => exactSystems.has(system)));
  } finally {
    await app.close();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("HTTP OpenAI Responses provider supports connection testing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mv-responses-e2e-"));
  process.env.MODEL_VERITY_DISABLE_KEYCHAIN = "1";
  process.env.MODEL_VERITY_MASTER_KEY = "responses-e2e-key";
  const received: any[] = [];
  const mock = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push({ url: req.url, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "gpt-responses", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 4, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } } }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); const port = typeof address === "object" && address ? address.port : 0;
  const app = await startServer({ port: 0, dataDir, webRoot: join(process.cwd(), "dist/web") });
  try {
    const provider = await json(app.state.url, "/api/providers", { method: "POST", body: JSON.stringify({ name: "Responses Mock", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "secret", models: ["gpt-responses"], role: "audit" }) });
    assert.equal(provider.protocol, "openai-compatible");
    const connection = await json(app.state.url, `/api/providers/${provider.id}/connection-tests`, { method: "POST", body: JSON.stringify({ model: "gpt-responses", protocol: "openai-responses" }) });
    const tested = await waitConnectionTest(app.state.url, connection.id);
    assert.equal(tested.status, "succeeded");
    assert.equal(tested.result.responseModel, "gpt-responses");
    assert.equal(received[0].url, "/v1/responses");
    assert.equal(received[0].body.input, "Connection test.");
    assert.equal(received[0].body.max_output_tokens, 8);
    assert.equal(tested.protocol, "openai-responses");
  } finally {
    await app.close();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("HTTP v2 screening persists observations and refuses strong conclusions without calibration", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mv-v2-e2e-"));
  process.env.MODEL_VERITY_DISABLE_KEYCHAIN = "1";
  process.env.MODEL_VERITY_MASTER_KEY = "v2-e2e-key";
  const mock = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const prompt = body.messages?.[1]?.content ?? "";
    const content = /coin/i.test(prompt) ? "heads" : /color/i.test(prompt) ? "blue" : /number/i.test(prompt) ? "7" : /letter/i.test(prompt) ? "a" : "cat";
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "v2-mock", choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); const port = typeof address === "object" && address ? address.port : 0;
  const app = await startServer({ port: 0, dataDir, webRoot: join(process.cwd(), "dist/web") });
  try {
    const provider = await json(app.state.url, "/api/providers", { method: "POST", body: JSON.stringify({ name: "V2 Mock", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "secret", models: ["openai/gpt-4o-mini"], role: "audit" }) });
    const expiresAt=new Date(Date.now()+60_000).toISOString();
    const authorization=await json(app.state.url,"/api/v2/budget-authorizations",{method:"POST",body:JSON.stringify({providerIds:[provider.id],models:["openai/gpt-4o-mini"],maxEndpointRequests:20,maxInputTokens:10000,maxOutputTokens:1000,maxAttemptsPerEndpoint:1,expiresAt})});
    const created = await json(app.state.url, "/api/v2/verification-runs", { method: "POST", body: JSON.stringify({ mode: "screening", providerId: provider.id, model: "openai/gpt-4o-mini", referenceId: "builtin:pamela:openai/gpt-5.4-mini", profile: "quick", protocolComparability: "P3", referenceLevel: "L3", identity: { declared: { vendor: "OpenAI", product: "GPT-4o mini", surface: "unknown" } }, budget: { authorizationId:authorization.id,maxPairs: 20, maxEndpointRequests: 20, maxAttemptsPerEndpoint: 1, expiresAt } }) });
    let run: any;
    for (let index = 0; index < 200; index += 1) { run = await json(app.state.url, `/api/v2/verification-runs/${created.id}`); if (!["queued","running"].includes(run.status)) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.result.conclusion.behavior.status, "uncalibrated");
    assert.equal(run.result.conclusion.strongConclusion, false);
    assert.equal(run.result.scorecard.policyVersion,"pamela-scorecard@3.1.0");
    assert.equal(typeof run.result.scorecard.score,"number");
    assert.ok(["review","low"].includes(run.result.scorecard.band));
    assert.ok(run.result.scorecard.caps.some((value:string)=>value.includes("诊断")));
    const observations = await json(app.state.url, `/api/v2/verification-runs/${run.id}/observations`);
    assert.equal(observations.items.length, 20);
    assert.ok(observations.items.every((item: any) => item.request_hash && item.pair_id));
    for(const format of ["json","markdown","csv"]){const exported=await fetch(`${app.state.url}/api/v2/verification-runs/${run.id}/export?format=${format}`);assert.equal(exported.status,200);const text=await exported.text();assert.ok(text.length>100);if(format==="json"){assert.match(text,/not vendor certification/);assert.match(text,/pamela-scorecard@3\.1\.0/);}if(format==="markdown")assert.match(text,/综合可信评分/);if(format==="csv")assert.match(text,/trust_score/);}
    const share=await json(app.state.url,`/api/v2/verification-runs/${run.id}/share-reports`,{method:"POST",body:"{}"});assert.match(share.reportHash,/^[a-f0-9]{64}$/);assert.equal("policy" in share.report,false);assert.ok(Array.isArray(share.report.endpointBindings));assert.ok(share.report.endpointBindings[0].configRevision);assert.ok(share.report.endpointBindings[0].credentialScopeHmac);assert.equal(JSON.stringify(share).includes("secret"),false);
    const shared=await json(app.state.url,`/api/v2/share-reports/${share.id}`);assert.equal(shared.revoked,false);const revoked=await fetch(`${app.state.url}/api/v2/share-reports/${share.id}`,{method:"DELETE"});assert.equal(revoked.status,200);
    const deleted=await fetch(`${app.state.url}/api/v2/verification-runs/${run.id}`,{method:"DELETE"});assert.equal(deleted.status,200);const missing=await fetch(`${app.state.url}/api/v2/verification-runs/${run.id}`);assert.equal(missing.status,404);
  } finally { await app.close(); await new Promise<void>((resolve) => mock.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});

test("HTTP P1/P2 comparability requires matching known product and surface", async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),"mv-comparability-"));process.env.MODEL_VERITY_DISABLE_KEYCHAIN="1";process.env.MODEL_VERITY_MASTER_KEY="comparability-key";
  const mock=createServer(async(req,res)=>{for await(const _ of req){}res.setHeader("content-type","application/json");res.end(JSON.stringify({model:"mock",choices:[{message:{content:"blue"}}]}));});await new Promise<void>((resolve)=>mock.listen(0,"127.0.0.1",resolve));const address=mock.address();const port=typeof address==="object"&&address?address.port:0;const app=await startServer({port:0,dataDir,webRoot:join(process.cwd(),"dist/web")});
  try{const target=await json(app.state.url,"/api/providers",{method:"POST",body:JSON.stringify({name:"Target",protocol:"openai-compatible",baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:"secret",models:["m"],role:"audit"})});const reference=await json(app.state.url,"/api/providers",{method:"POST",body:JSON.stringify({name:"Reference",protocol:"openai-compatible",baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:"secret",models:["m"],role:"reference"})});const expiresAt=new Date(Date.now()+60_000).toISOString();const auth=await json(app.state.url,"/api/v2/budget-authorizations",{method:"POST",body:JSON.stringify({providerIds:[target.id,reference.id],models:["m"],maxEndpointRequests:40,maxInputTokens:10000,maxOutputTokens:1000,maxAttemptsPerEndpoint:1,expiresAt})});const response=await fetch(`${app.state.url}/api/v2/verification-runs`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mode:"paired",providerId:target.id,referenceProviderId:reference.id,model:"m",referenceModel:"m",profile:"quick",protocolComparability:"P1",referenceLevel:"L2",identity:{declared:{vendor:"Example",product:"M",surface:"api"},reference:{vendor:"Example",product:"M",surface:"unknown"},observed:{targetProtocol:"openai-compatible",referenceProtocol:"openai-compatible"}},budget:{authorizationId:auth.id,maxPairs:20,maxEndpointRequests:40,maxAttemptsPerEndpoint:1,expiresAt}})});assert.equal(response.status,400);const errorBody=await response.json() as {error:string};assert.match(errorBody.error,/matching non-unknown product and surface/);
  }finally{await app.close();await new Promise<void>((resolve)=>mock.close(()=>resolve()));await rm(dataDir,{recursive:true,force:true});}
});

test("HTTP reference enrollment publishes an immutable usable reference version", async () => {
  const dataDir=await mkdtemp(join(tmpdir(),"mv-reference-enrollment-"));
  process.env.MODEL_VERITY_DISABLE_KEYCHAIN="1";process.env.MODEL_VERITY_MASTER_KEY="reference-enrollment-key";
  let requests=0;
  const mock=createServer(async(req,res)=>{let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests+=1;const prompt=body.messages?.find((message:any)=>message.role==="user")?.content??"";const content=/coin|монет|硬币|عملة|نقود/i.test(prompt)?(/نقود/i.test(prompt)?"صورة":/硬币/i.test(prompt)?"正面":/монет/i.test(prompt)?"орёл":"heads"):/city|город|城市|مدينة/i.test(prompt)?"paris":/animal|живот|动物|حيوان/i.test(prompt)?"cat":/color|цвет|颜色|لون/i.test(prompt)?"blue":/number|числ|随机数|数字|整数|عدد|رقم/i.test(prompt)?"7":/letter|букв|汉字|حرف/i.test(prompt)?"a":"apple";res.setHeader("content-type","application/json");res.end(JSON.stringify({model:"trusted-model",choices:[{message:{content}}],usage:{prompt_tokens:20,completion_tokens:1}}));});
  await new Promise<void>((resolve)=>mock.listen(0,"127.0.0.1",resolve));const address=mock.address();const port=typeof address==="object"&&address?address.port:0;
  const app=await startServer({port:0,dataDir,webRoot:join(process.cwd(),"dist/web")});
  try{
    const provider=await json(app.state.url,"/api/providers",{method:"POST",body:JSON.stringify({name:"Trusted Reference",protocol:"openai-compatible",baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:"secret",models:["trusted-model"],role:"reference"})});
    const expiresAt=new Date(Date.now()+60_000).toISOString();
    const authorization=await json(app.state.url,"/api/v2/budget-authorizations",{method:"POST",body:JSON.stringify({providerIds:[provider.id],models:["trusted-model"],maxEndpointRequests:20,maxInputTokens:16000,maxOutputTokens:320,maxAttemptsPerEndpoint:1,expiresAt})});
    const created=await json(app.state.url,"/api/v2/references/enrollment-plans",{method:"POST",body:JSON.stringify({providerId:provider.id,model:"trusted-model",protocol:"openai-compatible",label:"Trusted GPT baseline",profile:"quick",referenceLevel:"L2",identity:{declared:{vendor:"Example",product:"Trusted GPT",surface:"api"}},budget:{authorizationId:authorization.id,maxPairs:20,maxEndpointRequests:20,maxAttemptsPerEndpoint:1,expiresAt}})});
    const run=await waitV2Run(app.state.url,created.id);assert.equal(run.status,"completed",run.error);assert.equal(requests,20);assert.match(run.result.referenceEnrollment.referenceVersionId,/^[0-9a-f-]+$/);assert.equal(run.result.quality.usableCells,4);assert.equal(run.result.quality.successRate,1);
    const versions=await json(app.state.url,"/api/v2/reference-versions");assert.equal(versions.items.length,1);assert.equal(versions.items[0].qualityStatus,"approved");assert.equal(versions.items[0].freshnessStatus,"current");assert.equal(versions.items[0].level,"L2");assert.equal(Object.keys(versions.items[0].fingerprint.cells).length,4);
    const references=await json(app.state.url,"/api/references");const saved=references.items.find((value:any)=>value.id===run.result.referenceEnrollment.referenceVersionId);assert.ok(saved);assert.equal(saved.sourceType,"self-built-reference");assert.equal(saved.label,"Trusted GPT baseline");assert.equal(saved.readonly,true);
    const directImport=await fetch(`${app.state.url}/api/v2/reference-versions`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({})});assert.equal(directImport.status,410);
    const reviewUpdate=await json(app.state.url,`/api/v2/reference-versions/${saved.id}/governance-events`,{method:"POST",body:JSON.stringify({eventType:"review_required",details:{reason:"test"}})});assert.equal(reviewUpdate.eventType,"review_required");assert.equal(reviewUpdate.version.qualityStatus,"review_required");
    const staleUpdate=await json(app.state.url,`/api/v2/reference-versions/${saved.id}/governance-events`,{method:"POST",body:JSON.stringify({eventType:"marked_stale",details:{reason:"test"}})});assert.equal(staleUpdate.version.freshnessStatus,"stale");assert.equal(staleUpdate.version.qualityStatus,"approved");
    const staleReferences=await json(app.state.url,"/api/references");assert.equal(staleReferences.items.some((value:any)=>value.id===saved.id),false);
    const quarantineUpdate=await json(app.state.url,`/api/v2/reference-versions/${saved.id}/governance-events`,{method:"POST",body:JSON.stringify({eventType:"quarantined",details:{reason:"test"}})});assert.equal(quarantineUpdate.version.qualityStatus,"quarantined");
    const confirmedUpdate=await json(app.state.url,`/api/v2/reference-versions/${saved.id}/governance-events`,{method:"POST",body:JSON.stringify({eventType:"confirmed",details:{reason:"test"}})});assert.equal(confirmedUpdate.version.freshnessStatus,"current");assert.equal(confirmedUpdate.version.qualityStatus,"approved");
    const restoredReferences=await json(app.state.url,"/api/references");assert.equal(restoredReferences.items.some((value:any)=>value.id===saved.id),true);
  }finally{await app.close();await new Promise<void>((resolve)=>mock.close(()=>resolve()));await rm(dataDir,{recursive:true,force:true});}
});

test("HTTP enrollment then audit completes against deterministic mock provider", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mv-e2e-"));
  process.env.MODEL_VERITY_DISABLE_KEYCHAIN = "1";
  process.env.MODEL_VERITY_MASTER_KEY = "e2e-key";
  let requests = 0;
  const mock = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/models") {
      assert.equal(req.headers.authorization, "Bearer secret");
      res.end(JSON.stringify({ data: [{ id: "mock" }, { id: "mock-latest" }, { id: "mock" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/echo/v1/models") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: `upstream echoed ${req.headers.authorization}` } }));
      return;
    }
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.end(JSON.stringify({ data: [{ id: "mock" }, { id: "mock-latest" }, { id: "mock" }] }));
      return;
    }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests += 1;
    const prompt = body.messages?.[1]?.content ?? body.messages?.[0]?.content ?? "";
    if (prompt === "Connection test.") await new Promise((resolve) => setTimeout(resolve, 80));
    const content = prompt === "Connection test." ? "OK" : /coin|монет|硬币|عملة/i.test(prompt) ? "Heads" : /city|город|城市|مدينة/i.test(prompt) ? "Paris" : /animal|живот|动物|حيوان/i.test(prompt) ? "Cat" : /color|цвет|颜色|لون/i.test(prompt) ? "Blue" : /number|числ|数字|整数|عدد|رقم/i.test(prompt) ? "7" : /letter|букв|汉字|حرف/i.test(prompt) ? "A" : "Apple";
    res.end(JSON.stringify({ model: "deterministic-mock", choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockAddress = mock.address(); const mockPort = typeof mockAddress === "object" && mockAddress ? mockAddress.port : 0;
  const app = await startServer({ port: 0, dataDir, webRoot: join(process.cwd(), "dist/web") });
  try {
    const provider = await json(app.state.url, "/api/providers", { method: "POST", body: JSON.stringify({ name: "Trusted Mock", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "secret", models: ["mock"], role: "either" }) });
    const discovered = await json(app.state.url, "/api/providers/models", { method: "POST", body: JSON.stringify({ providerId: provider.id, protocol: provider.protocol, baseUrl: provider.baseUrl }) });
    assert.deepEqual(discovered.items, ["mock", "mock-latest"]);
    assert.equal(JSON.stringify(discovered).includes("secret"), false);
    const discoveredWithUnsavedKey = await json(app.state.url, "/api/providers/models", { method: "POST", body: JSON.stringify({ protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "secret" }) });
    assert.deepEqual(discoveredWithUnsavedKey.items, ["mock", "mock-latest"]);
    // Changing protocol or baseUrl must keep using the saved key without re-entering it.
    const changedTargetWithSavedKey = await json(app.state.url, "/api/providers/models", { method: "POST", body: JSON.stringify({ providerId: provider.id, protocol: "anthropic-messages", baseUrl: `http://127.0.0.1:${mockPort}/other` }) });
    assert.deepEqual(changedTargetWithSavedKey.items, ["mock", "mock-latest"]);
    const changedProviderWithSavedKey = await json(app.state.url, "/api/providers", { method: "POST", body: JSON.stringify({ id: provider.id, name: provider.name, protocol: "anthropic-messages", baseUrl: `http://127.0.0.1:${mockPort}/other`, models: provider.models, role: provider.role }) });
    assert.equal(changedProviderWithSavedKey.protocol, "anthropic-messages");
    assert.equal(changedProviderWithSavedKey.keyMasked.includes("secret"), false);
    // Restore the original target so the remaining run flow uses the working endpoint.
    await json(app.state.url, "/api/providers", { method: "POST", body: JSON.stringify({ id: provider.id, name: provider.name, protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${mockPort}/v1`, models: provider.models, role: provider.role }) });
    const echoedSecret = "custom-credential-without-standard-prefix";
    const echoed = await fetch(`${app.state.url}/api/providers/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${mockPort}/echo/v1`, apiKey: echoedSecret }) });
    assert.equal(echoed.status, 502);
    const echoedBody = await echoed.text();
    assert.equal(echoedBody.includes(echoedSecret), false);
    assert.match(echoedBody, /\[redacted\]/);
    const connection = await json(app.state.url, `/api/providers/${provider.id}/connection-tests`, { method: "POST", body: JSON.stringify({ model: "mock", protocol: "openai-compatible" }) });
    assert.equal(connection.status, "running");
    const blockedWhileTesting = await fetch(`${app.state.url}/api/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: provider.id, model: "mock", profile: "enroll" }) });
    assert.equal(blockedWhileTesting.status, 409);
    const connected = await waitConnectionTest(app.state.url, connection.id);
    assert.equal(connected.status, "succeeded");
    assert.equal(connected.result.ok, true);
    assert.equal(connected.result.httpStatus, 200);
    assert.equal(connected.result.responseModel, "deterministic-mock");
    assert.equal("text" in connected.result, false);
    const enroll = await json(app.state.url, "/api/enroll", { method: "POST", body: JSON.stringify({ providerId: provider.id, model: "mock", profile: "enroll" }) });
    const enrolled = await waitRun(app.state.url, enroll.id);
    assert.equal(enrolled.status, "completed");
    const references = await json(app.state.url, "/api/references");
    assert.equal(references.items.filter((item: any) => item.sourceType === "local-enrollment").length, 1);
    const localReference = references.items.find((item: any) => item.sourceType === "local-enrollment");
    const audit = await json(app.state.url, "/api/audits", { method: "POST", body: JSON.stringify({ providerId: provider.id, model: "mock", claimedModel: "mock-v1", referenceId: localReference.id, profile: "audit" }) });
    const audited = await waitRun(app.state.url, audit.id);
    assert.equal(audited.status, "completed", JSON.stringify({ error: audited.error, result: audited.result }));
    assert.equal(audited.claimedModel, "mock-v1");
    assert.equal(audited.result.trust, "likely_match");
    assert.equal(audited.result.score, 0);
    assert.equal(audited.result.verdictReason, "score_match");
    assert.equal(audited.result.decision.minCellsOk, 4);
    assert.equal(audited.result.reliability.counts.planned, 120);
    assert.equal(audited.result.run.providerName, "Trusted Mock");
    assert.equal(audited.result.cells.length, 8);
    assert.ok(Array.isArray(audited.result.excludedCells));
    for (const format of ["json", "markdown", "csv"]) {
      const exported = await fetch(`${app.state.url}/api/runs/${audited.id}/export?format=${format}`);
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
      assert.ok((await exported.text()).length > 50);
    }
    assert.ok(requests >= 360);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

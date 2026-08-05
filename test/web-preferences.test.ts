import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  loadVerificationPreferences,
  preferredItem,
  preferredModel,
  saveVerificationPreferences,
  VERIFICATION_PREFERENCES_KEY,
  type VerificationPreferences,
} from "../src/web/src/app/verification-preferences.js";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(VERIFICATION_PREFERENCES_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const preferences: VerificationPreferences = {
  mode: "screening",
  providerId: "provider-2",
  model: "model-b",
  referenceId: "reference-2",
  profile: "full",
  referenceProviderId: "provider-1",
  referenceModel: "model-a",
  targetProtocol: "openai-responses",
  referenceProtocol: "openai-compatible",
  vendor: "Vendor B",
  product: "Product B",
  surface: "api",
  referenceVendor: "Vendor A",
  referenceProduct: "Product A",
  referenceSurface: "api",
};

test("verification defaults select the first available item and preserve valid saved choices", () => {
  const providers = [{ id: "provider-1", models: ["model-a", "model-a2"] }, { id: "provider-2", models: ["model-b"] }];
  const references = [{ id: "reference-1" }, { id: "reference-2" }];
  assert.equal(preferredItem(providers, undefined)?.id, "provider-1");
  assert.equal(preferredModel(providers[0].models, undefined), "model-a");
  assert.equal(preferredItem(references, undefined)?.id, "reference-1");
  assert.equal(preferredItem(providers, "provider-2")?.id, "provider-2");
  assert.equal(preferredModel(providers[1].models, "model-b"), "model-b");
  assert.equal(preferredItem(references, "reference-2")?.id, "reference-2");
  assert.equal(preferredItem(providers, "deleted")?.id, "provider-1");
  assert.equal(preferredModel(providers[0].models, "deleted"), "model-a");
});

test("verification preferences round-trip without storing a temporary credential", () => {
  const storage = memoryStorage();
  saveVerificationPreferences(preferences, storage);
  assert.deepEqual(loadVerificationPreferences(storage), preferences);
  assert.doesNotMatch(storage.getItem(VERIFICATION_PREFERENCES_KEY)!, /apiKey|temporaryKey|credential/i);
  assert.deepEqual(loadVerificationPreferences(memoryStorage("not-json")), {});
});

test("verify reference picker separates self-built and research sources", async () => {
  const [workspace, css] = await Promise.all([
    readFile(new URL("../src/web/src/app/V2Workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/ui/styles/app.css", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /referenceSource/);
  assert.match(workspace, /self-built/);
  assert.match(workspace, /研究参考/);
  assert.match(workspace, /filteredReferences/);
  assert.match(workspace, /reference-source-filter/);
  assert.match(workspace, /还没有自建参考/);
  assert.match(css, /\.reference-source-filter/);
});

test("global loading state covers initial data sources and disables looping motion when requested", async () => {
  const [index, app, workspace, governance, css] = await Promise.all([
    readFile(new URL("../src/web/src/ui/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/app/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/app/V2Workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/app/V2ReferenceGovernance.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/ui/styles/app.css", import.meta.url), "utf8"),
  ]);
  assert.match(index, /export \{ LoadingState \}/);
  assert.match(app, /loading\?<LoadingState label="正在加载验证数据"/);
  assert.match(workspace, /if\(restoring\)return <LoadingState label="正在恢复验证状态"/);
  assert.match(governance, /if \(initialLoading\)[\s\S]*<LoadingState compact label="正在加载参考数据"/);
  assert.match(css, /@keyframes loading-cell/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.loading-grid span[\s\S]*animation: none !important/);
});

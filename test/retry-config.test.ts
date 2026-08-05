import assert from "node:assert/strict";
import test from "node:test";
import { buildRetryConfiguration } from "../src/web/src/app/retry-config.js";

const providers = [
  { id: "target", role: "audit" as const, models: ["gpt-target"] },
  { id: "reference", role: "reference" as const, models: ["gpt-reference"] },
];
const references = [{ id: "builtin:gpt-target" }];

test("history retry restores screening configuration without credentials or old authorization", () => {
  const restored = buildRetryConfiguration({
    mode: "screening",
    providerId: "target",
    model: "gpt-target",
    referenceId: "builtin:gpt-target",
    profile: "full",
    identity: {
      declared: { vendor: "OpenAI", product: "GPT Target", surface: "api" },
      observed: { targetProtocol: "openai-responses" },
    },
  }, providers, references);

  assert.deepEqual(restored, {
    mode: "screening",
    providerId: "target",
    model: "gpt-target",
    referenceId: "builtin:gpt-target",
    referenceProviderId: undefined,
    referenceModel: undefined,
    profile: "full",
    targetProtocol: "openai-responses",
    referenceProtocol: undefined,
    vendor: "OpenAI",
    product: "GPT Target",
    surface: "api",
    referenceVendor: undefined,
    referenceProduct: undefined,
    referenceSurface: undefined,
    omissions: [],
  });
  assert.equal("budget" in restored, false);
  assert.equal("apiKey" in restored, false);
});

test("history retry restores paired endpoint and identity configuration", () => {
  const restored = buildRetryConfiguration({
    mode: "paired",
    providerId: "target",
    referenceProviderId: "reference",
    model: "gpt-target",
    referenceModel: "gpt-reference",
    profile: "audit",
    identity: {
      declared: { vendor: "OpenAI", product: "GPT", surface: "api" },
      reference: { vendor: "OpenAI", product: "GPT", surface: "api" },
      observed: { targetProtocol: "openai-compatible", referenceProtocol: "anthropic-messages" },
    },
  }, providers, references);

  assert.equal(restored.mode, "paired");
  assert.equal(restored.providerId, "target");
  assert.equal(restored.referenceProviderId, "reference");
  assert.equal(restored.model, "gpt-target");
  assert.equal(restored.referenceModel, "gpt-reference");
  assert.equal(restored.targetProtocol, "openai-compatible");
  assert.equal(restored.referenceProtocol, "anthropic-messages");
  assert.equal(restored.vendor, "OpenAI");
  assert.equal(restored.referenceVendor, "OpenAI");
  assert.deepEqual(restored.omissions, []);
});

test("history retry fails closed when saved provider, model, or reference is unavailable", () => {
  const restored = buildRetryConfiguration({
    mode: "screening",
    providerId: "deleted-provider",
    model: "deleted-model",
    referenceId: "deleted-reference",
    profile: "quick",
    identity: { observed: { targetProtocol: "unsupported-protocol" } },
  }, providers, references);

  assert.equal(restored.providerId, undefined);
  assert.equal(restored.model, undefined);
  assert.equal(restored.referenceId, undefined);
  assert.equal(restored.targetProtocol, undefined);
  assert.equal(restored.omissions.length, 2);
});

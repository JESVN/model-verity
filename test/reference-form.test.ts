import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  generatedReferenceLabel,
  productAfterModelChange,
  referenceGovernanceStatus,
  referenceModelOptions,
  referenceVersionAfterGovernance,
} from "../src/web/src/app/reference-form.js";

test("reference display name is derived without becoming scoring input", () => {
  assert.equal(
    generatedReferenceLabel("9router", " OpenAI ", "gpt-5.6-sol", "cx/gpt-5.6-sol", new Date(2026, 7, 3)),
    "9router · OpenAI gpt-5.6-sol · 2026-08",
  );
  assert.equal(
    generatedReferenceLabel("Trusted", "", "", "model-id", new Date(2026, 0, 1)),
    "Trusted · model-id · 2026-01",
  );
});

test("custom upstream model survives later model ID changes", () => {
  assert.equal(productAfterModelChange("route-a", "route-b", false), "route-b");
  assert.equal(productAfterModelChange("actual-upstream", "route-b", true), "actual-upstream");
});

test("discovered models cannot bypass the provider model allowlist", () => {
  const options = referenceModelOptions(["configured"], ["configured", "remote-only"]);
  assert.equal(options.find((value) => value.value === "configured")?.disabled, false);
  assert.equal(options.find((value) => value.value === "configured")?.badge, "已配置");
  assert.equal(options.find((value) => value.value === "remote-only")?.disabled, true);
  assert.equal(options.find((value) => value.value === "remote-only")?.badge, "未配置");
});

test("reference form separates request routing from declared upstream identity", async () => {
  const source = await readFile(new URL("../src/web/src/app/V2ReferenceGovernance.tsx", import.meta.url), "utf8");
  assert.match(source, /从哪里采集/);
  assert.match(source, /这份参考代表什么/);
  assert.match(source, /发送给接口的模型 ID/);
  assert.match(source, /实际上游模型/);
  assert.match(source, /模型 ID 是别名，修改/);
  assert.match(source, /自定义显示名称（可选）/);
  assert.doesNotMatch(source, /label="参考名称"/);
  assert.doesNotMatch(source, /label="从模型列表接口获取"/);
  assert.doesNotMatch(source, /label="声明的模型产品"/);
});

test("reference governance actions update and select the effective status", () => {
  const current = { freshnessStatus: "current", qualityStatus: "approved" };
  const review = referenceVersionAfterGovernance(current, "review_required");
  assert.equal(referenceGovernanceStatus(review), "review_required");

  const stale = referenceVersionAfterGovernance(review, "marked_stale");
  assert.deepEqual(stale, { freshnessStatus: "stale", qualityStatus: "approved" });
  assert.equal(referenceGovernanceStatus(stale), "stale");

  const quarantined = referenceVersionAfterGovernance(stale, "quarantined");
  assert.equal(referenceGovernanceStatus(quarantined), "quarantined");

  const confirmed = referenceVersionAfterGovernance(quarantined, "confirmed");
  assert.deepEqual(confirmed, current);
  assert.equal(referenceGovernanceStatus(confirmed), "current");
});

test("reference page separates self-built governance from the research library", async () => {
  const [governance, app, styles] = await Promise.all([
    readFile(new URL("../src/web/src/app/V2ReferenceGovernance.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/app/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/ui/styles/app.css", import.meta.url), "utf8"),
  ]);
  assert.match(governance, /reference-overview-card/);
  assert.match(governance, /reference-version-status/);
  assert.match(governance, /aria-pressed=/);
  assert.match(governance, /referenceVersionAfterGovernance/);
  assert.match(governance, /状态变更只影响后续验证，不修改旧记录/);
  assert.match(app, /reference-library-card/);
  assert.match(app, /按模型名称筛选/);
  assert.match(styles, /\.reference-overview-header/);
  assert.match(styles, /\.reference-library-header/);
});

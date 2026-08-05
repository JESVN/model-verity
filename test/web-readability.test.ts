import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string): number {
  const left = luminance(foreground);
  const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

test("web helper text keeps readable size and contrast on the darkest information surface", async () => {
  const [tokens, css] = await Promise.all([
    readFile(new URL("../src/web/src/ui/styles/tokens.css", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/ui/styles/app.css", import.meta.url), "utf8"),
  ]);
  const color = (name: string) => tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  assert.ok(contrast(color("text-tertiary")!, color("bg-subtle")!) >= 5.5);
  assert.ok(contrast(color("text-secondary")!, color("bg-subtle")!) >= 7);
  for (const name of ["text-success", "text-warning", "text-danger", "trust-low"]) {
    assert.ok(contrast(color(name)!, color("bg-subtle")!) >= 4.5, `${name} must remain readable`);
  }
  assert.match(css, /\.field-help\s*\{[^}]*font-size:\s*13px[^}]*line-height:\s*1\.6/s);
  assert.match(css, /\.select-option-description\s*\{[^}]*font-size:\s*13px[^}]*line-height:\s*1\.5/s);
  assert.match(css, /\.history-list \.list-item-sub\s*\{[^}]*font-size:\s*13px[^}]*font-weight:\s*500[^}]*line-height:\s*1\.65/s);
  assert.match(css, /\.btn-primary\s*\{[^}]*color:\s*var\(--bg-deep\)[^}]*background:\s*var\(--brand-500\)/s);
  assert.match(css, /\.btn-primary:active:not\(:disabled\)\s*\{[^}]*color:\s*#fff[^}]*background:\s*var\(--brand-700\)/s);
});

test("provider action labels stay on one line when metadata is long", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/web/src/app/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/web/src/ui/styles/app.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /className="btn-row compact provider-actions"/);
  assert.match(css, /\.provider-actions\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.provider-actions \.btn\s*\{[^}]*white-space:\s*nowrap/s);
});

test("choice terminology provides more than a bare technical label", async () => {
  const source = await readFile(new URL("../src/web/src/app/terminology.ts", import.meta.url), "utf8");
  const descriptions = [...source.matchAll(/description:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(descriptions.length >= 20, "all choice groups should expose descriptions");
  const lengths = descriptions.map((value) => [...value].length);
  assert.ok(lengths.reduce((sum, value) => sum + value, 0) / lengths.length <= 38, "choice explanations should stay concise");
  for (const [index, description] of descriptions.entries()) {
    assert.ok(lengths[index] >= 20 && lengths[index] <= 55, "each choice needs a concise explanation");
    assert.match(description, /[。；]/, "each choice needs selection or impact guidance");
  }
});

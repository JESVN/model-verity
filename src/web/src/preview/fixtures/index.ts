import type {
  HistoryRow,
  PreviewSceneId,
  ProviderOption,
  ReferenceOption,
  RunningView,
  SetupView,
  VerificationResultView,
} from "@ui/types";

export const providers: ProviderOption[] = [
  {
    id: "official-openai",
    name: "OpenAI Official",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-compatible",
    role: "reference",
    models: ["gpt-4.1"],
    keyMasked: "sk-...a1b2",
  },
  {
    id: "official-anthropic",
    name: "Anthropic Official",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic-messages",
    role: "reference",
    models: ["claude-sonnet-4"],
    keyMasked: "sk-ant-...9f3c",
  },
  {
    id: "relay-a",
    name: "Relay-A（非官方）",
    baseUrl: "https://relay-a.example/v1",
    protocol: "openai-compatible",
    role: "audit",
    models: ["gpt", "claude", "grok-4.5"],
    keyMasked: "sk-...7d21",
  },
  {
    id: "sub2api-demo",
    name: "sub2api demo",
    baseUrl: "https://sub2api.example/v1",
    protocol: "openai-compatible",
    role: "either",
    models: ["grok-4.5"],
    keyMasked: "sk-...c0ff",
  },
];

export const references: ReferenceOption[] = [
  {
    id: "ref-gpt",
    label: "OpenAI · gpt-4.1",
    modelClaimed: "gpt-4.1",
    sourceBaseUrl: "https://api.openai.com/v1",
    enrolledAt: "2026-07-20 14:02",
    cellCoverage: "40/40",
  },
  {
    id: "ref-grok",
    label: "Trusted · grok-4.5",
    modelClaimed: "grok-4.5",
    sourceBaseUrl: "https://api.x.ai/v1",
    enrolledAt: "2026-07-21 09:18",
    cellCoverage: "8/40（轻量）",
  },
];

export const history: HistoryRow[] = [
  {
    id: "h1",
    when: "今天 11:20",
    provider: "Relay-A",
    model: "grok-4.5",
    trust: "likely_mismatch",
    score: 0.31,
  },
  {
    id: "h2",
    when: "昨天 21:04",
    provider: "sub2api demo",
    model: "grok-4.5",
    trust: "likely_match",
    score: 0.08,
  },
  {
    id: "h3",
    when: "昨天 18:40",
    provider: "Relay-A",
    model: "gpt",
    trust: "inconclusive",
    score: 0.18,
  },
];

const baseSetup = (): SetupView => ({
  providers,
  references,
  selectedProviderId: "relay-a",
  selectedModel: "grok-4.5",
  claimedModel: "grok-4.5",
  selectedReferenceId: "ref-grok",
  profile: "audit",
  estimatedRequests: 120,
  estimatedMinutes: 3,
  canStart: true,
});

const cells = [
  { cellId: "en:random_color", label: "EN · random color", jsd: 0.06, nValid: 15 },
  { cellId: "zh:random_number_100", label: "ZH · random number 1–100", jsd: 0.11, nValid: 14 },
  { cellId: "ru:coin_flip", label: "RU · coin flip", jsd: 0.04, nValid: 15 },
  { cellId: "ar:random_animal", label: "AR · random animal", jsd: 0.19, nValid: 13 },
  { cellId: "en:favorite_color", label: "EN · favorite color", jsd: 0.09, nValid: 15 },
  { cellId: "zh:random_city", label: "ZH · random city", jsd: 0.22, nValid: 12 },
  { cellId: "en:random_word", label: "EN · random word", jsd: 0.14, nValid: 15 },
  { cellId: "ru:random_letter", label: "RU · random letter", jsd: 0.07, nValid: 15 },
];

export interface SceneDefinition {
  id: PreviewSceneId;
  label: string;
  description: string;
  nav: "verify" | "providers" | "references" | "history";
  phase: "setup" | "running" | "result" | "list";
  narrow?: boolean;
  reducedMotion?: boolean;
  evidenceOpen?: boolean;
  setup?: SetupView;
  running?: RunningView;
  result?: VerificationResultView;
}

export const scenes: SceneDefinition[] = [
  {
    id: "P01",
    label: "P01 Setup",
    description: "默认设置，可点验证",
    nav: "verify",
    phase: "setup",
    setup: baseSetup(),
  },
  {
    id: "P02",
    label: "P02 无参考",
    description: "无 reference，主按钮禁用",
    nav: "verify",
    phase: "setup",
    setup: {
      ...baseSetup(),
      selectedReferenceId: null,
      canStart: false,
      disabledReason: "需要先从可信源建立参考指纹，才能给出真实性结论。",
    },
  },
  {
    id: "P03",
    label: "P03 进度 12%",
    description: "Running 低进度",
    nav: "verify",
    phase: "running",
    running: {
      profile: "audit",
      progress: 0.12,
      phaseLabel: "正在采样探针",
      cellCurrent: 1,
      cellTotal: 8,
      elapsedLabel: "0:18",
      successCount: 12,
      failCount: 0,
      detailLines: ["en:random_color · ok", "连接供应商 · ok"],
    },
  },
  {
    id: "P04",
    label: "P04 进度 67%",
    description: "Running 高进度",
    nav: "verify",
    phase: "running",
    running: {
      profile: "audit",
      progress: 0.67,
      phaseLabel: "正在采样探针",
      cellCurrent: 6,
      cellTotal: 8,
      elapsedLabel: "1:42",
      successCount: 78,
      failCount: 2,
      detailLines: [
        "zh:random_city · retry after 429",
        "ar:random_animal · ok",
        "en:random_word · ok",
      ],
    },
  },
  {
    id: "P05",
    label: "P05 结果 绿",
    description: "高可信 likely_match",
    nav: "verify",
    phase: "result",
    result: {
      trust: "likely_match",
      headline: "相对参考，单 token 行为分布高度接近。",
      score: 0.08,
      thresholds: { match: 0.12, mid: 0.22 },
      reference: {
        label: "Trusted · grok-4.5",
        enrolledAt: "建立于 2026-07-21 09:18",
      },
      reliability: { successRate: 0.983, p50ms: 820, p95ms: 1800, invalidRate: 0.012, counts: { planned: 120, succeeded: 118, failed: 2, valid: 116, invalid: 1, refusal: 1, empty: 0, error: 2 }, errorClasses: { timeout: 2 } },
      profile: "audit",
      cellsUsed: "8/8",
      reasons: ["JSD 0.080 ≤ 匹配阈值 0.120，且证据质量门槛全部满足。"],
      qualityChecks: [{ status: "pass", label: "请求成功率", detail: "98.3%，最低要求 70.0%" }, { status: "pass", label: "可比 cell", detail: "8/8，最低要求 4" }, { status: "pass", label: "协议完整性", detail: "reasoning 已确认关闭。" }],
      recommendations: ["定期复测以监控供应商路由变化。", "该结论仅表示相对参考接近，不是厂商认证。"],
      runInfo: { runId: "preview-run-05", providerName: "Relay-A（非官方）", endpoint: "https://relay-a.example/v1", requestedModel: "grok-4.5", claimedModel: "grok-4.5", startedAt: "2026-07-27 11:20", finishedAt: "2026-07-27 11:23", plannedRequests: 120, completedRequests: 120, batteryVersion: "project-equivalent@v1", normalizeVersion: "normalize@v1", systemPromptVersion: "one-word@v1" },
      responseModelWeakSignal: "grok-4.5-build-free",
      responseModelNote: "返回 model 与声称模型使用不同版本别名；不参与可信度判定。",
      protocolNote: "reasoning 已关闭",
      cells: cells.map((cell) => ({ ...cell, nRef: 30 })),
      excludedCells: [],
    },
  },
  {
    id: "P06",
    label: "P06 结果 黄",
    description: "中等可信 inconclusive",
    nav: "verify",
    phase: "result",
    result: {
      trust: "inconclusive",
      headline: "相对参考有接近迹象，但不足以高置信匹配。",
      score: 0.18,
      thresholds: { match: 0.12, mid: 0.22 },
      reference: {
        label: "OpenAI · gpt-4.1",
        enrolledAt: "建立于 2026-07-20 14:02",
      },
      reliability: { successRate: 0.94, p95ms: 2400, invalidRate: 0.04 },
      profile: "audit",
      cellsUsed: "8/40",
      protocolNote: "部分 cell 有效样本偏低",
      cells: cells.map((c, i) => ({ ...c, jsd: c.jsd + 0.08 + i * 0.01 })),
    },
  },
  {
    id: "P07",
    label: "P07 结果 红",
    description: "低可信 mismatch",
    nav: "verify",
    phase: "result",
    result: {
      trust: "likely_mismatch",
      headline: "相对参考，行为分布明显偏离。",
      score: 0.31,
      thresholds: { match: 0.12, mid: 0.22 },
      reference: {
        label: "Trusted · grok-4.5",
        enrolledAt: "建立于 2026-07-21 09:18",
      },
      reliability: { successRate: 0.97, p95ms: 1500, invalidRate: 0.02 },
      profile: "audit",
      cellsUsed: "8/40",
      responseModelWeakSignal: "gpt-proxy",
      cells: cells.map((c) => ({ ...c, jsd: Math.min(0.95, c.jsd + 0.25) })),
    },
  },
  {
    id: "P08",
    label: "P08 无法完成",
    description: "failed，非 mismatch",
    nav: "verify",
    phase: "result",
    result: {
      trust: "failed",
      headline: "无法完成验证：请求大量失败或被限流熔断。",
      reference: {
        label: "Trusted · grok-4.5",
        enrolledAt: "建立于 2026-07-21 09:18",
      },
      reliability: { successRate: 0.12, p95ms: 8000, invalidRate: 0 },
      profile: "audit",
      cellsUsed: "2/8 可用",
      protocolNote: "连续 429 / 5xx，已停止",
      cells: [],
    },
  },
  {
    id: "P09",
    label: "P09 依据展开",
    description: "Result + evidence open",
    nav: "verify",
    phase: "result",
    evidenceOpen: true,
    result: {
      trust: "likely_match",
      headline: "相对参考，单 token 行为分布高度接近。",
      score: 0.08,
      thresholds: { match: 0.12, mid: 0.22 },
      reference: {
        label: "Trusted · grok-4.5",
        enrolledAt: "建立于 2026-07-21 09:18",
      },
      reliability: { successRate: 0.983, p95ms: 1800, invalidRate: 0.012 },
      profile: "audit",
      cellsUsed: "8/40",
      cells,
    },
  },
  {
    id: "P10",
    label: "P10 窄屏",
    description: "单列布局模拟",
    nav: "verify",
    phase: "setup",
    narrow: true,
    setup: baseSetup(),
  },
  {
    id: "P11",
    label: "P11 深色对比",
    description: "固定深色主题对比度",
    nav: "verify",
    phase: "result",
    result: {
      trust: "inconclusive",
      headline: "相对参考有接近迹象，但不足以高置信匹配。",
      score: 0.16,
      thresholds: { match: 0.12, mid: 0.22 },
      reference: {
        label: "OpenAI · gpt-4.1",
        enrolledAt: "建立于 2026-07-20 14:02",
      },
      reliability: { successRate: 0.96, p95ms: 2100, invalidRate: 0.03 },
      profile: "audit",
      cellsUsed: "8/40",
      cells,
    },
  },
  {
    id: "P12",
    label: "P12 Reduced",
    description: "减弱动效",
    nav: "verify",
    phase: "running",
    reducedMotion: true,
    running: {
      profile: "quick",
      progress: 0.45,
      phaseLabel: "正在采样探针",
      cellCurrent: 2,
      cellTotal: 4,
      elapsedLabel: "0:36",
      successCount: 18,
      failCount: 0,
    },
  },
];

export function sceneById(id: PreviewSceneId): SceneDefinition {
  const s = scenes.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scene ${id}`);
  return s;
}

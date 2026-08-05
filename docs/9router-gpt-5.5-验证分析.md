# 9router `cx/gpt-5.5` 对内置 `openai/gpt-5.5` 验证分析

> 2026-07-31 更新：修正后的生产运行 `915c3270-c2b2-44ec-b6a5-bf9192317b75` 为 JSD `0.021452`、80/80 成功、覆盖 100%、短时稳定，行为分 97.9、综合证据分 86.2。`pamela-scorecard@3.1.0` 已部署：该类仅受 P3/研究参考范围限制的结果主显示“行为相似评分 98/100 · 行为高度相似”，另列“来源证据待复核”和综合证据分 86/100。权重、JSD、阈值和 cap 未放宽；行为分不是官方来源概率。

> 2026-07-30 更新：V3 生产存量记录 `cx/gpt-5.5` 为 76.7 分，`gpt-5.5` 为 79.6 分。两者均为无匹配 calibration、P3、L3 条件下的综合证据分，不是模型真实性概率。内置 fixed prompt 和动态时效修复只作用于新运行，旧记录保持冻结。

> 日期：2026-07-27  
> 性质：实测诊断，不是模型身份认证或欺诈判定。

## 结论摘要

`cx/gpt-5.5` Audit 的低档位不是请求失败导致。目标 run `9ed6f3a0-e152-456b-b02f-b8ee14fcaa6a` 的 120/120 请求成功，120 个回答全部有效，返回 `model` 全部为 `gpt-5.5`，且 adapter 判定 reasoning 已关闭。直接判定原因是平均 JSD `0.226539` 高于当前 `tauMid=0.22`。

该结果能支持的结论只有：**9router 当前 Chat Completions 服务链路的单词回答分布，相对 OpenRouter 2026-07-06 的 OpenAI `gpt-5.5-20260423` 快照发生了显著偏移。**它不能推出“9router 没有调用官方模型”。

现有实现存在三个重要校准问题：

1. 内置参考是 OpenRouter/OpenAI 特定 serving-stack 快照，不是厂商认证或跨账号、跨产品面恒定的模型本体。
2. 当前 `tauMatch=0.12` / `tauMid=0.22` 是全局手工默认值，未从随包数据按 profile、cell 子集、reference sample size 和跨 provider 场景重新标定；论文只报告 EER，不给出可直接复用的这两个阈值。对随包 40-cell split-half gallery 复算时，EER operating threshold 约为 `0.354`；当前阈值因此具有很低误接收但很高误拒绝的倾向。
3. 当前结果直接展示离散档位，但没有估计有限样本 JSD 的零假设分布、置信区间、p 值或多次 run 稳定性；高熵开放集 cell 会产生较大的有限样本正偏差。

## 观测事实

### 目标 Audit

- Run ID：`9ed6f3a0-e152-456b-b02f-b8ee14fcaa6a`
- Provider：9router
- 请求模型：`cx/gpt-5.5`
- 参考：`builtin:pamela:openai/gpt-5.5`
- Profile：Audit，8 cells × 15 repetitions = 120 requests
- 成功率：100%
- valid：120；invalid/refusal/empty/error：0
- 响应 `model`：`gpt-5.5` × 120
- reasoning：已关闭
- score：`0.22653922695626527`
- 阈值：`tauMatch=0.12`，`tauMid=0.22`
- verdict：`likely_mismatch`，原因 `score_mismatch`

Cell JSD：

| Cell | JSD |
|---|---:|
| `zh:animal-random` | 0.357041 |
| `en:word-random` | 0.108032 |
| `ru:color-favorite` | 0.000000 |
| `ar:city-random` | 0.356028 |
| `zh:word-random` | 0.476688 |
| `en:color-favorite` | 0.000000 |
| `ru:city-random` | 0.514525 |
| `ar:color-random` | 0.000000 |

固定偏好/颜色 cell 完全一致；偏差主要集中在随机动物、随机词和随机城市等高熵开放集任务。

### 内置参考的真实来源

随包数据确认：

- OpenRouter catalog model：`openai/gpt-5.5`
- serving provider：`OpenAI`
- 实际报告模型：`openai/gpt-5.5-20260423`
- 采集时间：`2026-07-06T19:43:40.928Z`
- Chat Completions 协议
- `temperature=1`
- `max_tokens=16`
- `reasoning:{enabled:false}`
- 每个 paper-1 cell 参考有效样本 30
- 参考短 prompt 的 `prompt_tokens` 约 40–56

因此“内置 gpt-5.5”精确含义是：OpenRouter 在该时间通过 OpenAI provider 服务的 `gpt-5.5-20260423` 行为快照。

### 9router 协议探针

对 `cx/gpt-5.5` 的最小连接测试：

- Chat Completions：成功；响应 `model=gpt-5.5`；input tokens 405
- Responses：成功；响应未提供 `model`；input tokens 405
- 两者均报告 reasoning 已关闭

对完整 PAMELA 中文随机词 prompt，各跑 10 次：

- Chat：全部成功，响应对象 `chat.completion`，input tokens 恒为 432
- Responses：全部成功，响应对象 `response`，input tokens 恒为 432
- 两种协议的分布都与参考存在较大 JSD；Responses 没有自动改善一致性

参考同 cell 的输入 token 是 45，而 9router 报告 432。该差异是当前最强的 serving-context 差异信号，但不能仅凭 usage 数值断言网关注入了 387 个 token；也可能是 9router/GPT 账号产品面对隐藏 instructions、工具上下文、计费口径或 usage 重映射。需要在 9router 出站层和上游响应层分别记录原始 body/usage 才能定因。

## 核心流程检查

### 已对齐

内置参考路径使用精确 PAMELA prompt、语言对应 system prompt、`temperature=1`、输出上限 16、同一 normalizer 版本。2026-07-30 复核发现当前验证 manifest 曾在固定 PAMELA user prompt 后追加无语义 `Request marker`，而 Zenodo 内置分布没有该 marker；这会引入不必要的 serving-context 差异。现已修正：内置研究参考比较使用原始固定 prompt；marker 只保留在实时配对和自建参考流程，因为这些流程的两端或后续参考使用相同 marked protocol。旧运行不重算、不覆盖。

### 未对齐或不可证明

- 参考走 OpenRouter Chat Completions；9router 的 `cx` 账号通道可能经过不同 API 产品面或内部转换。
- 参考报告精确 snapshot `openai/gpt-5.5-20260423`；9router 只返回通用 `gpt-5.5`。
- 参考输入 token 40–56；9router 为 405/432，说明模型实际条件上下文或 usage 口径不一致。
- model-verity 不能看到 9router 发给上游的最终 request，也不能验证账号产品面、service tier、region、hidden instructions、tools 或重试/fallback。

### 指标与档位漏洞

- 原始 JSD 算法实现正确：base-2、对称、支持集并集、cell 等权平均，与论文公式一致。
- 但 plug-in empirical JSD 在小样本、高基数分布上有明显正偏差。参考 n=30、Audit n=15 时，即使来自同一已知参考分布，目标 8-cell 子集的平均 JSD 模拟均值约 0.096，95% 分位约 0.116；若把参考本身也视为 30 样本估计，正偏差更高。
- 论文报告的是 gallery 全体模型 split-half ROC/EER，不等于 `tauMatch=0.12` 或 `tauMid=0.22` 的来源证明。当前全局阈值没有随 profile、cell 难度、样本数、同 provider/跨 provider场景调整。
- 论文明确报告跨 provider 同模型距离中位数约 0.227；目标分数 0.226539 与该中位数几乎相同。这说明当前 `>0.22 => likely_mismatch` 对跨 serving-stack 场景偏激进。
- 当前 `likely_mismatch` 中文“明显偏离”容易被理解为“非官方模型”，应进一步强调“相对此参考 deployment 偏离”。
- 对本次恰好抽中的 8-cell 子集重建随包 split-half gallery，EER 阈值约 `0.439`、EER 约 10.6%；在该子集上 `tauMid=0.22` 的 genuine false reject 约 47.8%。这不是应立即把阈值改为 0.439 的理由，而是强证据表明 cell 子集难度差异很大，全局固定阈值不可校准地混用了不同 operating points。
- 相同 `model` 返回值只是弱信号；当前实现正确地没有把它加入 JSD，但 UI 应把“snapshot 缺失/不一致”作为可比性限制。

## 补充实验

### 同一路径本地 Enrollment

建立 `9router · cx/gpt-5.5` 本地参考后，以同一路径 Quick audit：

- score：`0.009818`
- verdict：`likely_match`
- 响应 `model=gpt-5.5` × 40

这证明当前 9router 路径自身短时稳定，主要矛盾是它与内置 OpenRouter 快照的 serving context 不同，而不是 9router 每次随机路由到完全不同模型。

2026-07-30 同时修正内置参考时效：按冻结规则 `0–14 天 current、15–45 天 usable、超过 45 天 stale` 动态计算，不再将全部内置参考无条件标记为 stale。2026-07-06 参考在 2026-07-29 运行时应为 usable。

该 Enrollment 也暴露本地协议质量问题：240 个响应中 87 个被 project-equivalent normalizer 判 invalid，仅 5/8 cells 达到 nValid>=10，导致 Audit profile 无法使用该 8-cell 本地参考；Quick 只抽到 4 个合格 cell 才成功。这说明本地 Enrollment 与 PAMELA 内置协议目前是两套 battery/normalizer，不能作为严格 A/B 等价实验，后续应支持“按内置参考协议重新 enrollment”。

## 改进优先级

### P0：修正表达和校准

1. 将 `likely_mismatch` 展示为“相对所选参考 deployment 明显偏离”，禁止简化为“模型不可信/非官方”。
2. 内置参考显示精确 reported snapshot、采集 provider、采集时间和协议，而不只显示 catalog alias。
3. 停止把 `0.12/0.22` 描述为已由论文验证；标记为应用默认启发式阈值。
4. 按 Quick/Audit/Full 分别从随包 split-score 数据重建 ROC，保存阈值来源、FAR/FRR 和版本。复算全 40-cell split-half 数据得到 EER 阈值约 `0.354`（EER 约 8.2%，与论文 7.3% 接近；差异来自随包 curated 子集/实现细节）。在全 40-cell split-half gallery 上，当前 `0.12` 的 false reject 约 56.3%，`0.22` 仍约 28.5%，证明现阈值明显偏严；但该全量阈值也不能直接用于任意 8-cell subset，必须按 profile 校准。
5. 为跨 provider/跨产品面比较提供独立、更保守的阈值或默认 `inconclusive` 区间。

### P1：增加统计可靠性

1. 对每次 run 基于参考 multinomial 做 parametric bootstrap，给出有限样本零假设分布、期望噪声、95% 区间和 tail probability。
2. 报告 observed JSD 与 expected sampling JSD 的差值或标准化分数，不只报告原始平均 JSD。
3. 对高熵开放 cell 使用 shrinkage/Dirichlet smoothing，或按估计方差加权；保留原始 JSD 供审计。
4. 将稳定低熵 cell 与高熵开放 cell 分组展示，避免 3 个零距离 cell 被 3 个高方差 cell 的原始均值掩盖。
5. 对重复 Audit 做一致性分析；一次 8-cell run 不直接形成身份结论。

### P1：协议可比性

1. Run 快照固化 adapter、请求 endpoint、精确 body schema、temperature、top_p、token 字段、reasoning control、headers 摘要、usage 口径和响应 object。
2. 增加透明代理诊断：记录 model-verity 出站 body hash；允许 9router 返回/展示其上游 body hash和原始 usage，用于确认是否注入 context。
3. 若请求模型 alias 与响应 snapshot 不同，展示 `requested cx/gpt-5.5 → reported gpt-5.5 → reference gpt-5.5-20260423`，标记 snapshot 不可证明一致。
4. 内置参考默认只使用 Chat Completions；Responses 对比应有独立 enrollment/reference，不能假设协议等价。

### P2：更可靠的实验设计

采用配对、同时间、同协议设计：

1. 在可信第一方 API 或明确目标账号产品面建立 reference，而不是只依赖历史 OpenRouter快照。
2. 通过 9router 和可信 reference 同时、交错执行完全相同的 cell/rep 顺序。
3. 固定并记录 temperature、top_p、seed（若支持）、max tokens、reasoning、service tier、region、API schema。
4. 两边均记录最终上游 request hash、reported snapshot、usage、provider、时间和重试次数。
5. 使用 16–40 cells，并在多个时段重复；8 cells 只作为筛查。
6. 预注册阈值和允许的 FAR/FRR；结果输出效应量、区间和 p 值，不输出伪“可信概率”。
7. 同时设置阳性对照（同路径重复）和阴性对照（已知其他模型），确认本次测试有区分能力。

## 安全说明

本次诊断使用了已保存供应商并产生真实付费请求：两次最小连接测试、20 次协议探针、一次本地 Enrollment（240 请求）和一次本地 Quick audit（40 请求）。未在文档中写入 API Key 或回答全文数据集。新增本地参考 ID 为 `a8c8528e-4439-4ae6-9142-7ed043d46ea2`；它是诊断产物，且仅 5/8 cells 达到当前 Audit 最低有效样本要求。

# model-verity 项目上下文

## 项目定位

验证第三方 AI **服务声明**的 Node.js CLI + Web 工具。PAMELA/Zenodo 行为分布是核心，输出 0–100 综合可信评分。评分不是模型真实性概率、厂商认证、密码学来源证明或未来保证。

当前数据面为 `service-claims@3.0.0`，评分规则为 `pamela-scorecard@3.1.0`。不要恢复旧 Audit/Enrollment、Legacy UI、旧记录派生评分或 `/api/runs` 前端读取。当前导航仅有：验证、供应商、参考样本、历史。

当前生产为 Review #010；旧业务数据已清理，供应商和加密密钥保留。History 详情独立留在“历史”导航。Review #006 已于 2026-08-03 通过此前生产基线人工验收，Review #009 已于 2026-08-04 通过用户生产环境人工验收，Review #010 已于 2026-08-05 通过用户生产环境人工验收（加载/保存性能：SecretStore 密钥缓存去重 scrypt、前端 15s 请求超时、`/api/bootstrap` 单请求首载）；自建参考表单语义去重、参考样本页分区布局、状态颜色与即时切换、验证页参考来源筛选均已部署。主要统计阻塞是缺少独立 calibration；npm 发布仍需单独批准。

## 不可突破的证据边界

- 行为相似不等于来源证明；`response.model` 仅是可伪造的弱信号。
- 研究参考、自建参考、用户声明和中转路径不能表述为官方认证。
- L1 仅限系统识别并锁定的官方直连；用户自建参考只允许 L2/L3。
- P1 要求厂商、产品、非 unknown 产品面及协议相同；P2 允许协议语义映射；P3 仅作诊断。
- 没有匹配 calibration 时保持未校准；生产始终强制 `strongConclusion:false`。
- 当前数据未证明预注册目标：行为支持 FAR ≤1%、明显异常 FRR ≤1%。GPT-5.5 与 GPT-5.4 在现有 probes 下不可可靠区分。
- 结果页顶部必须显示：`验证结果仅供参考，无法保证百分之百准确。`

## 当前评分

权重：行为 55、请求质量 15、短时稳定性 10、可比性 10、参考强度 10。无 calibration 时行为分为 `100 × (1 − JSD)`，只作连续展示。

结论上限与数值分分开保存。无 calibration 最高“基本可信”；P3、L3+stale、低成功率、低覆盖或行为混合最高“需要复核”；不通过质量治理的参考最高“可信度较低”。当高行为相似度仅因 P3/研究参考范围受限时，界面以行为维度分作为主“行为相似评分”，保留综合证据分用于审计，并分开显示“行为高度/较为相似”和“来源证据待复核”；主评分环按展示分着色（85–100 绿色、70–84 柔和绿、50–69 黄色、0–49 红色、无分灰色），来源范围 badge 继续黄色。真实质量/稳定性 cap 仍按 cap 后等级着色。不得把来源 cap 表述成行为不相似，也不得把行为分表述成官方来源概率。不要为提高分数改权重、删除高 JSD cell、挑选好结果或放宽 cap。

## Challenge 与参考

Manifest 当前为 `pamela-challenge@2`，必须保存 `promptMode`：

- `fixed`：内置 PAMELA 研究参考；使用 Zenodo 原始固定 prompt，不追加 marker。
- `marked`：实时双端配对和自建参考；双方或参考版本与后续目标使用同一 marked protocol。

内置参考时效：0–14 天 `current`、15–45 天 `usable`、超过 45 天 `stale`。无效或未来时间 fail-closed 为 stale。内置库 2026-08-05 起为 33 个主流厂商当前代模型（claude、openai、gemini、deepseek、kimi、qwen、glm、grok）；原 146 模型备份 `src/data/builtin-fingerprints.json.gz.bak-146`，删除项仍可从 Zenodo 数据集恢复。

内置 `openai/gpt-5.5` 精确代表 2026-07-06 经 OpenRouter/OpenAI provider 采集的 `gpt-5.5-20260423` serving 快照，不代表所有官方账号、协议或产品面。旧 76.7/79.6 分记录保持冻结，不重算。

内置库支持“参考样本”页在线更新（`src/server/zenodo-update.ts` + `/api/v2/references/update/*`）：检查更新 → 下载 Zenodo 数据集（缓存上限 2GB、一键清理、`MODEL_VERITY_ZENODO_PROXY` 可选代理，默认直连）→ 勾选模型应用。同 ID 模型整体替换新快照（保留最近 3 版本可回滚）；新数据集 `prompts_sha256` 与本地电池不一致时拒绝更新，避免跨 prompt 不可比。更新只写数据目录运行时库（`builtin-library/`），不改 dist 基线、不回写 git；测试用本地 mock Zenodo，不访问真实站点。

自建参考固定真实请求预算：Quick 20、Audit 80、Full 240。质量门禁：成功率 ≥90%，可用 cells ≥75% 且至少 4 个，满足每 cell 有效样本门槛，reasoning 关闭确认，完整执行冻结 manifest。0 自动重试，包括禁止 reasoning 兼容性补发。

## 安全与生产操作

- 自动测试、build、smoke、部署不得调用真实供应商。任何真实验证/参考采集必须由用户明确批准供应商、模型和请求预算。
- 临时 API Key 只存内存，绑定 run/endpoint role；完成、失败、取消、过期或重启后销毁。
- 长期 Key 加密保存；不得输出 Key、query、userinfo 或未脱敏 endpoint。
- SSRF 默认拒绝私网、loopback、link-local、CGNAT、保留地址和 redirect。本地 mock 才可设置 `MODEL_VERITY_ALLOW_PRIVATE_ENDPOINTS=1`。
- 删除生产数据、迁移、恢复、降低安全控制或其他不可逆操作：先检查无活跃任务、完整备份、说明影响，再执行。
- npm 发布与生产部署分开批准；当前 npm 版本 `0.1.0`，不得自动发布。
- 项目目录当前没有 `.git`；不要声称完成了分支、提交或 working-tree 审计。

生产：`https://modelverity.example/`。HTTPS 和 Basic Auth 当前启用；未认证公网请求返回 401，认证用户可调用 API。应用监听 `127.0.0.1:8787`，systemd 服务为 `model-verity`，数据目录 `/var/lib/model-verity/config/model-verity`。使用 `scripts/deploy-production.sh` 部署，它负责维护锁、候选 smoke、备份和回滚门禁。部署后检查 systemd、health/status、资源、API、SQLite integrity 和维护锁。

## 架构与状态模型

主链路：Web 表单 → API 校验/预算授权 → `V2RunManager` → adapter → append-only observation/attempt → evidence/stability → V3 scorecard → SQLite/History/导出。

- 服务端运行和数据库是状态真源；`localStorage` 只保存跟踪 ID/已查看状态，用于刷新和多标签恢复。
- observation、attempt、参考版本和治理事件不可覆盖；重采集创建新版本。旧完成记录保留当时 manifest/evidence/scorecard，不按新规则回写。
- 请求预算按供应商、模型、request、attempt、input/output token 原子限制；正式 runner 0 自动重试。
- 结果同时保留原始 JSD、五维 evidence、scorecard 数值、raw band、cap 后 band 和限制原因。
- History 详情是独立视图，保持“历史”导航激活；验证运行结果属于“验证”工作区。

信息源优先级：运行代码和 schema/API 测试 > 实时生产只读检查 > `AGENTS.md`/当前协议与计划 > 日期命名历史报告。文档与实现冲突时先确认事实，再修代码或文档，不能为了匹配文档而猜测。

## 新任务执行流程

开始任何优化、修复或功能开发：

1. 先判断任务属于 UI、runner/adapter、评分统计、参考治理、API/DB、安全部署中的哪一层。
2. 只读取上文“按任务读取文档”中相关文档，再定位调用链、类型、repository 和已有测试；不要先通读全部历史。
3. 明确当前行为、期望行为、证据语义、费用/安全影响和是否涉及真实供应商或生产数据。
4. 优先复现或用已保存 evidence 做只读诊断；自动化诊断不得偷偷发送供应商请求。
5. 做最小、根因级修改；不要顺带重构无关模块，不恢复已退役兼容路径。
6. 添加覆盖根因和边界的回归测试；先跑相关测试，再跑完整门禁。
7. 同步受影响的当前文档；历史报告只追加后续修正说明，不改写当时事实。
8. 若任务明确要求生产生效，使用部署脚本并做后置检查；否则说明尚未部署。生产部署不等于 npm 发布。

### 修复 Bug

- 记录可观察症状、入口路径、状态来源和根因；不要只改按钮文字或掩盖错误。
- 检查直接进入、History 进入、刷新恢复、多标签、运行中/完成/失败/取消等相邻路径。
- 服务端错误必须 fail-closed，前端提供可操作中文提示；不能把预算、协议或 token 错误降级成普通 observation。
- 旧记录默认不可变。若旧数据无法按新语义解释，明确标记或停止展示，不静默重算。
- 修复完成至少证明：原问题失败、补丁后通过、相邻路径未回归。

### 优化

- 优化前保存基线：延迟、请求数、token、JSD/coverage、bundle、交互步骤或可复现截图；优化后用同一口径比较。
- 性能优化不得改变请求语义、预算、manifest、重试策略或证据等级，除非任务明确要求且同步版本/校准。
- 评分优化必须改善可比性、采样设计或 calibration，不能以“分数更好看”为目标。
- UI 优化保持当前视觉体系，优先减少认知负担、避免溢出、保持键盘/焦点/reduced-motion 和 44px 触控目标。
- 不把单次生产结果当普遍改进；统计调整需要预注册规则、阴性样本和独立 holdout。

### 开发新功能

- 开工前写清：用户问题、默认流程、高级流程、输入/输出、状态机、失败/取消/恢复、预算、隐私、删除和审计字段。
- 新证据字段必须定义“是什么、怎么得到、能证明什么、不能证明什么”；用户声明、观察和推断分层保存。
- 新 runner/protocol 必须定义 adapter 语义映射、reasoning 行为、超时、0 重试、usage、错误分类、SSRF 和 mock 测试。
- 新数据库写入优先独立表或版本化 JSON；需要 migration 时先在生产副本演练并准备回滚。不可变记录使用 append-only event。
- 新 UI 默认只展示完成任务必需字段；专家控制放高级区域。新增术语同步 `terminology.ts` 和界面说明。
- 新导出/分享字段同步 JSON、Markdown、CSV；CSV 文本继续防公式注入，报告继续绑定 endpoint/config revision 且不泄密。
- 不新增旧代际名称、内部阶段标签或没有操作能力的导航/设置页。

## 完成标准

代码任务只有满足以下条件才可称为完成：

- 根因或设计目标明确，修改范围可解释；
- 类型检查和相关/完整测试通过，build/smoke/audit 按风险执行；
- 未发生未授权真实请求、预算扩张、密钥泄露或旧证据改写；
- UI 变更说明人工验收项，自动测试不能代替移动端、键盘和理解度检查；
- 当前文档已同步，历史事实未被覆盖；
- 若已部署，报告生产资源、服务状态、API/DB 检查和回滚备份；若未部署，明确写出。

## 常用门禁

```bash
npm run typecheck
npm test
npm run build
npm run smoke:v2
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
```

修改代码后运行与改动匹配的测试；发布或部署前运行全部门禁。当前基线为 61 tests，但以实际输出为准。测试/build/smoke 不得调用真实供应商。

## 关键代码

- `src/core/v3/scoring.ts`：V3 评分和 cap。
- `src/core/v2/`：challenge、evidence、calibration、policy、stability、reference freshness。
- `src/core/adapters/`：Chat Completions、Responses、Anthropic adapters。
- `src/server/v2-run-manager.ts`：验证/参考采集 runner、预算、manifest、scorecard。
- `src/server/api.ts`、`src/server/db.ts`：API 门禁、SQLite repository 和删除级联。
- `src/server/credential-sessions.ts`、`src/server/report-binding.ts`：临时凭据和报告 endpoint/config 绑定。
- `src/web/src/app/V2Workspace.tsx`：验证流程。
- `src/web/src/app/V2ReferenceGovernance.tsx`：自建参考和治理。
- `src/web/src/ui/components/V2ResultPanel.tsx`：评分优先结果页。
- `src/web/src/app/App.tsx`：导航、供应商、独立 History 详情。
- `src/web/src/app/api.ts`、`src/web/src/app/terminology.ts`：前端 API 类型和统一中文术语。
- `scripts/deploy-production.sh`：生产维护锁、候选检查、备份和回滚。
- `test/`：核心、API、mock、E2E 和评分回归。

## 按任务读取文档

不要每次读取全部文档。先用本文件建立上下文，再按任务读取：

- 产品和快速入口：`README.md`
- 当前验证规则：`docs/验证协议.md`
- V3 评分/结论：`docs/v3实施计划.md`
- GPT-5.5/内置参考：`docs/9router-gpt-5.5-验证分析.md`
- UI 优化/新交互：`docs/界面规范.md`、`docs/界面验收-Review-006.md`、`docs/界面验收-Review-007.md`、`docs/界面验收-Review-008.md`、`docs/界面验收-Review-009.md`
- API/DB/参考治理：`docs/v2实施计划.md`、`docs/验证协议.md`
- 生产部署/回滚/安全变更：`docs/部署指南.md`、`docs/对抗式检查.md`
- 开发新功能前查当前进度与阻塞：`docs/开发进度.md`、`docs/待处理事项.md`；完成后同步 `docs/已完成事项.md`
- 统计矩阵：`docs/M8-*.md`
- 数据重置：`docs/V3生产数据重置-20260729.md`

日期命名的 M8/M9、重置和旧验收文档是历史证据；其中资源名、测试数或认证状态可能是当时快照。当前状态以代码、实时检查、本文件和最新已批准 Review #010 为准。发现冲突时先核对实现，不要静默猜测；修复后同步相关文档。

维护本文件时只保留新会话必需的当前事实和硬约束；不要加入运行流水账、资源 hash、完整备份清单或可从代码快速查到的细节。重大架构、证据边界、生产安全或常用门禁变化时才同步更新。

## 工作方式

保持现有深色暖色、品牌橙色、卡片、圆角、排版和动效风格，不整体重构。术语必须说明“是什么、怎么选、影响什么”。历史详情保持在“历史”导航内独立展示；“再次验证”才切换验证页。回答和改动保持简洁，优先最小、可测试、可回滚的修改。

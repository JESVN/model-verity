# UI Review #009 — 参考状态颜色与即时切换

> 状态：Production · Approved  
> 建档与部署日期：2026-08-04  
> 人工验收通过日期：2026-08-04  
> 当前生产资源：`index-IJMiDkPo.js` / `index-8VsZv4RY.css`  
> 部署备份：`/root/backups/model-verity/deploy-20260803T173640Z-1638817`

## 用户问题

参考版本状态栏只有同色文字和灰色背景，用户无法快速区分当前可用、过期、待复核和暂停。四个治理按钮也只是普通命令按钮，没有显示当前选中的状态。点击多个状态时，前端依赖重新加载完整版本列表且未锁定并发操作；同时“标记为过期”只更新 freshness，可能保留此前的 `review_required/quarantined` quality，导致状态栏仍被旧状态主导。

## 根因与修复

- 为状态建立明确视觉层级：当前可用绿色、仍可使用柔和绿、已过期黄色、待复核品牌橙、暂停/替代中性灰。
- 状态卡同时显示彩色圆点、总体状态文字、时效 badge、质量 badge 和影响说明，不只依赖颜色。
- 四个治理按钮改为单选式反馈；当前状态显示边框、底色、对勾及 `aria-pressed=true`。
- 点击后先乐观更新状态卡和按钮，再锁定其他状态操作；服务端失败回滚，成功后使用服务端返回的完整 reference version 校正。
- 治理 API 在 append-only event 之外返回转换后的版本，前端不再依赖一次额外列表 reload 才能看到结果。
- “标记为过期”规范为 `freshness=stale, quality=approved`，使其成为确定的过期状态；该版本仍不能用于新验证，不会绕过参考门禁。
- 待复核和暂停继续保留 freshness；确认仍可用恢复 `current + approved`。所有治理事件仍按原顺序追加，旧验证记录不修改。

本次不改变采样、评分、预算、质量门禁、manifest、证据等级或既有验证结果。

## 自动验证

- TypeScript web/node：通过。
- Tests：67/67。
- Production build：通过。
- V2 candidate smoke：通过；强结论保持关闭，旧写 API 410。
- Production dependency audit：0 vulnerabilities。
- 参考治理单元测试覆盖 effective status、过期清除旧质量状态和确认恢复。
- HTTP E2E 覆盖待复核、过期、暂停、确认的服务端返回版本和验证列表接入。
- 未调用真实供应商，未发布 npm。

## 部署后检查

- systemd：`active/running`，`NRestarts=0`；应用仅监听 `127.0.0.1:8787`。
- `/api/health`、`/api/status`、`/api/v2/policy`：通过；无维护、无活跃任务，`strongConclusionsEnabled:false`。
- 生产保留 1 个自建参考版本，状态为 `current/approved`；部署未触发治理操作或改写业务记录。
- 本地、安装目录和实际服务资源 SHA-256 一致。
- SQLite `integrity_check` / `quick_check`：`ok`；维护锁已清除。
- HTTPS 未认证首页/API 返回 401；HTTP 返回 301 并跳转 HTTPS。
- 候选 `18787`、Vite `5173`、Preview `4173` 均无监听；没有遗留本地测试服务。

## 人工验收清单

1. 当前可用版本显示绿色状态卡、绿色圆点和“当前可用”，时效/质量 badge 同时可见。
2. 点击“标记为过期”，按钮立即出现对勾和选中样式，状态卡立即切换为黄色“已过期”。
3. 点击“标记为待复核”，选中态转移到对应按钮，状态卡切换为橙色“待复核”。
4. 点击“暂停用于验证”，选中态转移到暂停按钮，状态卡切换为中性灰“已暂停”。
5. 点击“确认仍可用”，选中态回到确认按钮，状态卡恢复绿色“当前可用”。
6. 快速连续点击时只接受一个进行中的操作，按钮不会出现多个选中态或旧请求覆盖新状态。
7. 刷新页面后状态与最后一次成功操作一致；服务端失败时恢复操作前状态并显示错误。
8. 切换不同参考版本时，每个版本显示自己的状态和对应选中按钮。
9. 在 320–430px 下状态卡、badge 和四个按钮无水平溢出，文字与颜色都可辨认。
10. 用键盘切换状态，确认焦点可见、`aria-pressed` 更新，reduced-motion 下不依赖动画表达结果。

## 后续变更

2026-08-04，用户反馈验证页选择参考样本时内置研究和自建参考混在同一列表里难以区分。已在参考样本 Select 上方增加“全部 / 自建参考 / 研究参考”来源筛选并显示各自数量；切换后只展示对应来源并自动选中该来源下最匹配的参考，空自建时给出创建指引。该变更随后连同状态优化一并部署生产。

## 来源筛选部署后检查

- systemd：`active/running`，`NRestarts=0`；应用仅监听 `127.0.0.1:8787`。
- `/api/health`、`/api/status`、`/api/v2/policy`：通过；无维护、无活跃任务，`strongConclusionsEnabled:false`；旧写 API 410。
- 生产保留 3 个供应商和 1 个自建参考版本（`current/approved`）；部署未触发治理操作或改写业务记录。
- 本地、安装目录和实际服务资源 SHA-256 一致；SQLite `integrity_check` / `quick_check`：`ok`；维护锁已清除。
- HTTPS 未认证首页/API 返回 401；HTTP 返回 301。候选、Vite、Preview 和 smoke 临时端口均无监听。

## 人工验收结果

2026-08-04，用户在生产环境确认参考状态颜色、即时切换和来源筛选正常，Review #009 **Approved**。该批准覆盖本次状态与来源筛选变更，并一并关闭此前未完成人工验收的 Review #007（自建参考表单语义）和 Review #008（参考样本分区布局）对应检查项。统计强结论门禁、证据边界和 npm 发布审批保持独立，不因 UI 验收而解除。npm 发布仍需单独批准。

---

## 后续变更（2026-08-05）— 首次加载与保存/加载性能修复 · Review #010

> 本节为 Review #009 之后的追加说明；上文为当时快照，不改写。

### 用户问题

2026-08-04 起，用户反馈首次刷新网页时“正在加载验证数据”停留过长，且其它页面的保存与加载数据操作也普遍偏慢。

### 真相与根因

- 后端服务本身快：600 次并发采样 p50 5.5ms / p95 33ms / p99 79ms / max 162ms，无持续停顿；此前观察到的一批 462/212/104ms 是重启后一次性冷启动（首次 scrypt + 解压内置库 + WAL checkpoint）。
- 根因一：`SecretStore` 每次 `get/set` 都为每个 provider 重跑内存昂贵 KDF（scrypt ≈50-60ms/次），`/api/providers` 3 个 provider 同步读 ≈150ms，为其它端点 10 倍以上。
- 根因二：openresty 整站 `auth_basic` 使用 bcrypt `$2a$10$`，nginx 每请求重算哈希且不缓存（实测 ≈132ms/请求、2 worker）；叠加 App 首次加载 6-7 个、每次保存约 5 个往返请求，穿代理后普遍数百毫秒。

### 修复

- `SecretStore` 增加按进程缓存的 AES 密钥（按 salt）与解密文档缓存，写入时失效；密钥、加密格式与安全语义不变。生产 `/api/providers` 由 ~150ms 降至 ~2ms。
- 前端 `request()` 增加 15s 有界超时（AbortController），任一请求挂起时给出可操作中文提示，不再让“正在加载验证数据”永久停留。
- 新增 `GET /api/bootstrap`，一次返回 providers/references/runs/status；`App.refresh()` 改用单请求，首次加载 7→3、保存后刷新 4→1 个穿代理请求。
- 顺带移除客户端无调用方的 `api.providers()/references()/v2Runs()/status()` 死代码（服务端对应端点保留，供部署检查与诊断）。

### 自动验证

- TypeScript web/node：通过；Tests：68/68。
- Production build、V2 candidate smoke 通过；npm audit 0 漏洞。
- 未调用真实供应商；未发布 npm。

### 部署后检查

- systemd `active`；`/api/health`、`/api/status`、`/api/v2/policy` 通过，`strongConclusionsEnabled:false`，旧写 API 410。
- `/api/bootstrap` 内容完整（3 providers / 148 references / 3 runs），预热后 ~5ms；SQLite `integrity_check: ok`；维护锁已清除。
- 当前生产资源更新为 `index-JjgN9rqC.js` / 重建后的 `dist/server/index.js`；备份由部署脚本维护（`/root/backups/model-verity/`）。

### 人工验收结果

2026-08-05，用户在生产环境人工验证加载与保存明显加快，Review #010 **Approved**。统计强结论门禁、证据边界和 npm 发布审批保持独立，不因性能验收而解除。npm 发布仍需单独批准。

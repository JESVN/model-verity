import type { ApiProtocol } from "./api";

export const PROTOCOL_OPTIONS = [
  { value: "openai-compatible", label: "OpenAI Chat Completions", description: "调用 /chat/completions 的聊天接口。按服务文档选择；选错会请求失败。" },
  { value: "openai-responses", label: "OpenAI Responses", description: "调用 /responses 的 Responses 接口。按服务文档选择；混用协议会降低可比性。" },
  { value: "anthropic-messages", label: "Anthropic Messages", description: "调用 /messages 的 Anthropic 接口。按服务文档选择；选错会请求失败。" },
];
export function protocolLabel(value:string|undefined){return PROTOCOL_OPTIONS.find((item)=>item.value===value)?.label??value??"未记录";}
export function protocolHelp(value:ApiProtocol|string|undefined){return PROTOCOL_OPTIONS.find((item)=>item.value===value)?.description??"协议决定请求路径和字段。按服务文档选择；两端不同会降低可比性。";}

export const SURFACE_OPTIONS = [
  { value:"api",label:"API 接口",description:"通过 API 请求收发消息。多数中转站和开发者服务选此项；同类 API 之间最容易比较，结论最可靠。" },
  { value:"chatgpt",label:"ChatGPT 产品",description:"在 ChatGPT 网页或应用中使用。它有独立的界面设置与隐藏提示，不能与普通 API 等同比较。" },
  { value:"codex",label:"Codex 编程产品",description:"在 Codex 编程代理产品中使用。它面向编程任务，必须与同为 Codex 的参考比较。" },
  { value:"enterprise",label:"企业专属部署",description:"企业租户或专属部署。组织级配置会改变回答，应使用同类部署作参考。" },
  { value:"unknown",label:"无法确认",description:"不清楚模型以哪种形态提供时选择。系统按最保守范围处理，只比较回答行为，不推断来源。" },
];
export function surfaceLabel(value:string|undefined){return SURFACE_OPTIONS.find((item)=>item.value===value)?.label??value??"未记录";}
export function surfaceHelp(value:string){return SURFACE_OPTIONS.find((item)=>item.value===value)?.description??"产品形态指模型以哪种方式被提供和使用：API 接口、网页产品、编程产品或企业专属部署。同一模型在不同形态下的回答可能不同，所以比较时目标与参考应选同一形态；选错或选“无法确认”会降低可比性。";}

export const COMPARABILITY_OPTIONS = [
  { value:"P1",label:"P1 · 条件一致",description:"两端厂商、产品、产品形态和协议一致。比较条件最完整，但仍不是厂商认证。" },
  { value:"P2",label:"P2 · 协议不同",description:"两端厂商、产品和产品形态一致，但 API 协议不同。可比较，结论范围较窄。" },
  { value:"P3",label:"P3 · 仅看行为",description:"两端条件不同或信息不足。只能判断回答是否接近，不能确认来源。" },
];
export function comparabilityLabel(value:string|undefined){return COMPARABILITY_OPTIONS.find((item)=>item.value===value)?.label??value??"未记录";}
export function comparabilityHelp(value:string){return COMPARABILITY_OPTIONS.find((item)=>item.value===value)?.description??"系统按两端条件自动判断；条件越不一致，结论范围越窄。";}

export const REFERENCE_LEVEL_OPTIONS = [
  { value:"L2",label:"L2 · 你信任的路径",description:"你信任该 API 路径，但系统不能证明它是官方直连。多数自建参考选此项。" },
  { value:"L3",label:"L3 · 研究或本地样本",description:"公开研究、社区或来源较弱的样本。来源无法充分确认时选择；只作有限比较。" },
];
export function referenceLevelLabel(value:string|undefined){return value==="L1"?"L1 · 系统确认的官方直连":REFERENCE_LEVEL_OPTIONS.find((item)=>item.value===value)?.label??value??"未记录";}
export function referenceLevelHelp(value:string|undefined){if(value==="L1")return"系统锁定的官方 API，来源证据最强；行为接近仍不是身份证明。";return REFERENCE_LEVEL_OPTIONS.find((item)=>item.value===value)?.description??"等级说明参考为何可信；等级越低，来源结论越受限。";}

export const VERIFY_PROFILE_OPTIONS = [
  {value:"quick",label:"快速 · 20 组样本",description:"4 种问题，每种 5 次。费用最低，适合初筛；波动相对较大。"},
  {value:"audit",label:"标准 · 80 组样本",description:"8 种问题，每种 10 次。覆盖、耗时和费用较均衡，推荐日常使用。"},
  {value:"full",label:"完整 · 240 组样本",description:"16 种问题，每种 15 次。覆盖最广，费用和耗时最高。"},
];
export const REFERENCE_PROFILE_OPTIONS = [
  {value:"quick",label:"快速 · 20 次请求",description:"4 种问题，每种 5 次。费用最低；每种都需 5 个有效回答。"},
  {value:"audit",label:"标准 · 80 次请求",description:"8 种问题，每种 10 次。覆盖、耗时和费用较均衡，推荐日常使用。"},
  {value:"full",label:"完整 · 240 次请求",description:"16 种问题，每种 15 次。覆盖最广，费用和耗时最高。"},
];
export function profileLabel(value:string|undefined){return ({quick:"快速",audit:"标准",full:"完整"} as Record<string,string>)[value??""]??value??"未记录";}

export const PROVIDER_ROLE_OPTIONS = [
  {value:"audit",label:"仅作为验证目标",description:"只用于检查第三方服务，不会出现在可信参考列表。"},
  {value:"reference",label:"仅作为可信参考",description:"只用于自建参考或实时配对，不会作为验证目标。"},
  {value:"either",label:"目标和参考均可",description:"既可被检查，也可作为参考。仅在确实信任该路径时选择。"},
];
export function providerRoleLabel(value:string){return PROVIDER_ROLE_OPTIONS.find((item)=>item.value===value)?.label??value;}

export const MODEL_ID_HELP="发送给 API 的模型名称，例如 gpt-5.5。按服务文档填写；名称本身不证明模型身份。";
export const DECLARED_VENDOR_HELP="填写实际上游模型厂商，如 OpenAI，不填中转站；两端不同会限制比较。";
export const DECLARED_PRODUCT_HELP="填写实际模型或版本，如 GPT-5.5；两端不同会限制比较。";
export const REFERENCE_SAMPLE_HELP="用于对照的历史回答分布。优先选择同产品、同形态、同协议的近期样本。";
export const SAMPLING_BUDGET_HELP="样本越多，覆盖通常越完整，但费用和等待也越高；预算不会自动增加。";
export function verificationModeHelp(value:string){return value==="paired"?"同时请求目标端和参考端，对照更新；请求数约为两倍。":"只请求目标端，再与已保存样本比较；费用较低。";}

export function runStatusLabel(value:string){return ({queued:"等待开始",running:"进行中",completed:"已完成",failed:"失败",cancelled:"已取消"} as Record<string,string>)[value]??value;}
export function phaseLabel(value:string){return ({planning:"正在准备测试问题",sampling:"正在发送测试请求",completed:"已完成",failed:"失败"} as Record<string,string>)[value]??value;}
export function freshnessLabel(value:string|undefined){return ({current:"当前有效",usable:"仍可使用",stale:"已过期"} as Record<string,string>)[value??""]??value??"未记录";}
export function freshnessHelp(value:string|undefined){return value==="current"?"采集不超过 14 天，最接近当前状态。":value==="usable"?"采集已有 15–45 天，仍可用，但结论更保守。":"采集超过 45 天或日期无效，新验证会受限或无法使用。";}
export function qualityLabel(value:string|undefined){return ({approved:"质量已通过",review_required:"需要复核",quarantined:"已暂停使用",superseded:"已被新版本替代"} as Record<string,string>)[value??""]??value??"未记录";}
export function qualityHelp(value:string|undefined){return value==="approved"?"成功率和样本完整性达标，可用于新验证。":value==="review_required"?"来源或质量存疑，确认前不可用于新验证。":value==="quarantined"?"已暂停用于新验证，旧记录仍保留。":"已有新版本；旧记录保留，新验证使用新版本。";}
export function connectionCategoryLabel(value:string|undefined){return ({success:"连接成功",auth:"鉴权失败",rate_limit:"触发限流",timeout:"请求超时",network:"网络错误",server:"上游服务错误",invalid_response:"响应格式无法解析",cancelled:"已取消",other:"其他错误"} as Record<string,string>)[value??""]??value??"未记录";}
export function verificationModeLabel(value:string){return value==="paired"?"实时双端配对":value==="reference_enrollment"?"创建参考样本":"参考样本比对";}

export const BUILTIN_UPDATE_COPY = {
  title: "内置研究参考更新",
  help: "内置研究参考来自 Zenodo 研究数据集（DOI 10.5281/zenodo.21278557，CC BY 4.0）。检查更新发现新版本后，可下载数据集（首次需数百 MB，仅下载一次，之后从缓存读取）并选择要纳入的模型；同 ID 模型会直接替换为新快照，保留最近 3 个版本可回滚。",
  check: "检查更新",
  prepare: "下载并准备新数据集",
  apply: "更新所选模型",
  rollback: "回滚到上一版本",
  cleanCache: "清理数据集缓存",
  cancel: "取消",
  refresh: "重新检查",
  current: "当前内置库",
  latest: "Zenodo 最新版本",
  upToDate: "已是最新版本，无需更新",
  updateAvailable: "在 Zenodo 上发现更新版本",
  notChecked: "尚未检查，点击“检查更新”获取最新版本",
  bundled: "打包基线",
  runtime: "运行时更新",
  downloading: "下载中（首次需数百 MB，之后从缓存读取）",
  catalogReady: "模型列表已就绪，勾选后执行更新",
  selectHandled: "仅能纳入通过 40-cell 与有效样本门槛的模型",
  incompatible: "新数据集与当前电池 prompt 不一致，系统已拒绝更新",
  prepareDone: "数据集已就绪",
  noneQualified: "没有可用模型",
  noHistory: "无回滚可用",
  lastErrorTitle: "最近一次检查出错",
};

export function apiErrorMessage(value:string):string {
  const rules:[RegExp,string][]=[
    [/another task is active/i,"已有验证、参考采集或连接测试正在进行。请等待它结束或先取消，再启动新任务。"],
    [/P1 requires identical target and reference protocols/i,"P1“条件一致”要求目标端和参考端使用完全相同的请求协议。请统一协议，或使用 P2“协议不同”/P3“仅看行为”。"],
    [/P1\/P2 requires matching non-unknown product and surface/i,"P1/P2 要求目标与参考填写相同的模型产品和产品形态，而且产品形态不能是“无法确认”。信息不足时只能使用 P3“仅看行为”。"],
    [/research or legacy references require P3/i,"研究参考或历史参考缺少可核对的同产品形态资料，只能使用 P3“仅看行为”。"],
    [/reference version is not currently usable/i,"该参考版本已过期、待复核或暂停使用，不能启动新的验证。请更换参考或在参考样本页处理状态。"],
    [/reference fingerprint not found/i,"找不到所选参考样本。它可能已被删除或状态已变化，请重新选择。"],
    [/budget authorization not found/i,"找不到本次预算授权。请返回表单重新批准后启动。"],
    [/budget authorization expired|budget must not be expired/i,"本次预算授权已过期。请返回表单重新批准。"],
    [/run budget exceeds authorization/i,"任务请求上限超过已批准预算。请返回表单重新批准，不会自动扩大预算。"],
    [/endpoint request budget exhausted/i,"已达到本次请求预算上限，系统已停止发送后续请求。"],
    [/token stop limit exceeded/i,"最新回答使 token（模型处理文本的计费单位）用量达到停止上限。系统已记录实际用量，并停止后续请求。"],
    [/provider API key unavailable/i,"无法取得该供应商的 API Key。请在供应商页重新保存密钥，或为本次任务填写临时 Key。"],
    [/private provider endpoint blocked/i,"该地址指向内网、本机或保留地址。为防止服务器被借用访问内部资源，系统已拒绝连接。"],
    [/reference quality gate failed: success rate ([\d.]+)% is below 90%/i,"参考采集未发布：请求成功率为 $1%，低于 90% 质量门槛。"],
    [/reference quality gate failed: (\d+)\/(\d+) usable cells; (\d+) required/i,"参考采集未发布：计划测试的 $2 种问题组合中，只有 $1 种收集到足够的有效回答，至少需要 $3 种。"],
    [/reference quality gate failed: reasoning disablement was not confirmed/i,"参考采集未发布：无法确认隐藏推理已关闭，因此请求条件不够一致。"],
    [/reference collection did not complete the frozen manifest/i,"参考采集未发布：预定问题和次数没有全部完成，通常由预算用尽、取消或请求失败造成。"],
    [/server restarted before run completed/i,"服务在任务完成前重启。系统不会自动重发真实请求；请重新检查预算后手动启动。"],
    [/cancelled by user/i,"任务已由用户取消。"],
    [/run the update check first/i,"请先点击“检查更新”获取最新数据集版本，再执行后续操作。"],
    [/another Zenodo update task is active/i,"已有数据集准备任务在运行，请等待其完成后再次操作。"],
    [/Zenodo returned HTTP/i,"Zenodo 服务暂时不可用，请稍后重试。"],
    [/resolved to a private address/i,"Zenodo 地址解析到内网或保留地址，已按安全策略拒绝连接。"],
    [/(dataset too large|exceeds \d+ bytes)/i,"数据集超过大小上限，已拒绝下载。请删除缓存后重试。"],
    [/dataset zip file not found/i,"Zenodo 记录中未找到数据集压缩包，无法准备更新。"],
    [/not .* prepared|尚未准备/i,"数据集尚未下载或准备完成，请先执行“下载并准备新数据集”。"],
  ];
  for(const [pattern,message] of rules)if(pattern.test(value))return value.replace(pattern,message);
  return value;
}

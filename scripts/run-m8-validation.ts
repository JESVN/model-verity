import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { adapterFor } from "../src/core/adapters/registry.ts";
import type { AdapterId, OneWordResponse } from "../src/core/adapters/types.ts";
import { PAMELA_BATTERY, pamelaSystemPrompt } from "../src/core/battery/pamela.ts";
import { normalizePamelaAnswer } from "../src/core/normalize/pamela.ts";
import { empiricalDistribution, jsDivergence, type CellDistribution } from "../src/core/stats/index.ts";
import { SecretStore } from "../src/server/secrets.ts";

const DATA_DIR = process.env.MODEL_VERITY_M8_DATA_DIR ?? "/var/lib/model-verity/config/model-verity";
const OUTPUT = process.env.MODEL_VERITY_M8_OUTPUT ?? "artifacts/m8/m8-validation-20260728.json";
const BATCH_ID = `M8-LOW-BUDGET-${new Date().toISOString()}`;
const REQUEST_LIMITS: Record<string, number> = { "9router": 640, "随想": 160, "AiCodeWith": 80 };
const INPUT_TOKEN_LIMITS: Record<string, number> = { "9router": 360_000, "随想": 85_000, "AiCodeWith": 11_000 };
const OUTPUT_TOKEN_LIMITS: Record<string, number> = { "9router": 12_000, "随想": 8_000, "AiCodeWith": 1_000 };

interface Provider { name: string; protocol: AdapterId; baseUrl: string; secretRef: string; headers: Record<string,string> }
interface Endpoint { provider: Provider; model: string; role: "reference"|"target"|"negative"|"internal" }
interface Challenge { id: string; family: string; block: number; cellId: string; repetition: number; system: string; user: string; hash: string }
interface Observation { provider: string; endpointRole: string; model: string; challengeId: string; family: string; block: number; cellId: string; repetition: number; requestHash: string; startedAt: string; finishedAt: string; latencyMs?: number; validity: string; category?: string; responseModel?: string; reasoningDisabled?: boolean; usage?: {inputTokens?:number;outputTokens?:number}; errorCategory?: string; error?: string }
interface PairRecord { caseId:string;phase:string;block:number;challengeId:string;requestHash:string;firstRole:string;startGapMs:number;completionGapMs:number;complete:boolean;reference:Observation;target:Observation }

const DEV_CELLS = ["en:word-random", "ru:city-random", "zh:animal-random", "ar:color-random"];
const CALIBRATION_CELLS = ["en:word-random", "ru:city-random", "zh:animal-random", "ar:color-random", "en:coin-flip", "ru:color-favorite", "zh:num10-random", "ar:animal-random"];
const HOLDOUT_CELLS = ["en:city-random", "ru:animal-random", "zh:word-random", "ar:word-random"];
const counters: Record<string,{requests:number;inputTokens:number;outputTokens:number}> = {};
const observations: Observation[] = [];
const pairs: PairRecord[] = [];

const db = new Database(`${DATA_DIR}/db.sqlite`, { readonly: true });
const secrets = new SecretStore(DATA_DIR);
const providerRows = db.prepare("SELECT name,protocol,base_url,secret_ref,headers_json FROM providers WHERE deleted_at IS NULL").all() as any[];
const providers = Object.fromEntries(providerRows.map(row => [row.name, { name:row.name, protocol:row.protocol, baseUrl:row.base_url, secretRef:row.secret_ref, headers:JSON.parse(row.headers_json) } satisfies Provider]));
for (const name of Object.keys(REQUEST_LIMITS)) if (!providers[name]) throw new Error(`missing provider ${name}`);
const keys: Record<string,string> = {};
for (const [name, provider] of Object.entries(providers)) { const key=await secrets.get(provider.secretRef); if(key) keys[name]=key; }
for (const name of Object.keys(REQUEST_LIMITS)) if (!keys[name]) throw new Error(`credential unavailable for ${name}`);

const endpoint = (provider:string, model:string, role:Endpoint["role"]):Endpoint => ({provider:providers[provider],model,role});
const reference55=endpoint("9router","cx/gpt-5.5","reference");
const reference56=endpoint("9router","cx/gpt-5.6-sol","reference");
const cases=[
  {id:"gpt55-suixiang",reference:reference55,target:endpoint("随想","gpt-5.5","target"),product:"GPT-5.5",comparability:"P2"},
  {id:"gpt56sol-suixiang",reference:reference56,target:endpoint("随想","gpt-5.6-sol","target"),product:"GPT-5.6-sol",comparability:"P2"},
  {id:"gpt56sol-aicodewith",reference:reference56,target:endpoint("AiCodeWith","gpt-5.6-sol","target"),product:"GPT-5.6-sol",comparability:"P2"},
];
const phases:any={blockMatrix:[],internal:[],negatives:[],holdout:[]};

try {
  console.log(JSON.stringify({batchId:BATCH_ID,plan:{requests:REQUEST_LIMITS,inputTokenLimits:INPUT_TOKEN_LIMITS,outputTokenLimits:OUTPUT_TOKEN_LIMITS,retries:0}}));

  // 240 requests: three scenarios, four interleaved blocks, ten pairs per block.
  const blockJobs=[] as Array<{caseItem:typeof cases[number];challenge:Challenge}>;
  for (const caseItem of cases) for(let block=0;block<4;block++) {
    const challenges=makeBlockChallenges(`dev:${caseItem.id}`,DEV_CELLS,block,10,"development");
    for(const challenge of challenges) blockJobs.push({caseItem,challenge});
  }
  shuffle(blockJobs, seededRandom("m8-block-matrix-order"));
  for(const job of blockJobs) {
    const pair=await executePair(job.caseItem.id,"development",job.caseItem.reference,job.caseItem.target,job.challenge);
    pairs.push(pair);
    progress("block-matrix");
  }
  for(const caseItem of cases) phases.blockMatrix.push(summarizeCase(caseItem.id,"development"));
  checkpoint();

  // 160 requests: internal genuine samples, split odd/even after collection.
  for(const ref of [reference55,reference56]) {
    const family=`internal:${ref.model}`;
    const samples=makeCellChallenges(family,CALIBRATION_CELLS,10,"calibration-internal");
    for(const challenge of samples) observations.push(await executeOne({...ref,role:"internal"},challenge));
    phases.internal.push(summarizeInternal(ref.model,family));
    progress(`internal ${ref.model}`);
  }
  checkpoint();

  // 240 requests: three focused behavioral negatives.
  const negatives=[
    endpoint("9router","cx/gpt-5.4","negative"),
    endpoint("9router","cx/gpt-5.4-mini","negative"),
    endpoint("9router","cx/gpt-5.6-luna","negative"),
  ];
  for(const negative of negatives) {
    const family=`negative:${negative.model}`;
    for(const challenge of makeCellChallenges(family,CALIBRATION_CELLS,10,"calibration-negative")) observations.push(await executeOne(negative,challenge));
    phases.negatives.push(summarizeNegative(negative.model,family));
    progress(`negative ${negative.model}`);
  }
  checkpoint();

  // Freeze descriptive development ranges before holdout. They are not 1% calibration artifacts.
  const development=buildDevelopmentSummary();
  const frozenAt=new Date().toISOString();
  const frozenHash=hash(JSON.stringify(development));

  // 240 requests: independent challenge cells, 40 pairs per target scenario.
  const holdoutJobs=[] as Array<{caseItem:typeof cases[number];challenge:Challenge}>;
  for(const caseItem of cases) for(const challenge of makeCellChallenges(`holdout:${caseItem.id}`,HOLDOUT_CELLS,10,"holdout")) holdoutJobs.push({caseItem,challenge});
  shuffle(holdoutJobs,seededRandom("m8-holdout-order"));
  for(const job of holdoutJobs) {
    const pair=await executePair(job.caseItem.id,"holdout",job.caseItem.reference,job.caseItem.target,job.challenge);
    pairs.push(pair); progress("holdout");
  }
  for(const caseItem of cases) phases.holdout.push(summarizeCase(caseItem.id,"holdout"));

  const report={
    batchId:BATCH_ID,createdAt:new Date().toISOString(),framework:"service-claims@2-candidate",
    referencePolicy:{level:"L2",provider:"9router",models:["cx/gpt-5.5","cx/gpt-5.6-sol"],notice:"User-designated trusted reference path; not independently verified L1 origin."},
    scope:{longTermStability:"not_assessed",strongConclusionsEnabled:false,reason:"Small descriptive calibration cannot establish frozen 1% FAR/FRR targets."},
    budget:{limits:{requests:REQUEST_LIMITS,inputTokens:INPUT_TOKEN_LIMITS,outputTokens:OUTPUT_TOKEN_LIMITS},used:counters,retries:0},
    protocol:{pairConcurrency:1,pairRequestsStartedTogether:true,pairOrder:"seeded-random",rawSaved:false,developmentCells:DEV_CELLS,calibrationCells:CALIBRATION_CELLS,holdoutCells:HOLDOUT_CELLS},
    frozenDevelopment:{frozenAt,hash:frozenHash,summary:development},phases,pairs,observations,
  };
  mkdirSync(OUTPUT.substring(0,OUTPUT.lastIndexOf("/")),{recursive:true,mode:0o700});
  writeFileSync(OUTPUT,JSON.stringify(report,null,2)+"\n",{mode:0o600});
  console.log(JSON.stringify({complete:true,output:OUTPUT,budget:report.budget,development:report.frozenDevelopment,holdout:phases.holdout}));
} finally { db.close(); }

async function executePair(caseId:string,phase:string,reference:Endpoint,target:Endpoint,challenge:Challenge):Promise<PairRecord>{
  const random=seededRandom(`${caseId}:${phase}:${challenge.id}`); const referenceFirst=random()<.5;
  let refStart=0,targetStart=0;
  const runRef=()=>{refStart=performance.now();return executeOne(reference,challenge)};
  const runTarget=()=>{targetStart=performance.now();return executeOne(target,challenge)};
  const started=referenceFirst?[runRef(),runTarget()]:[runTarget(),runRef()];
  const values=await Promise.all(started); const referenceObs=referenceFirst?values[0]:values[1]; const targetObs=referenceFirst?values[1]:values[0];
  observations.push(referenceObs,targetObs);
  return {caseId,phase,block:challenge.block,challengeId:challenge.id,requestHash:challenge.hash,firstRole:referenceFirst?"reference":"target",startGapMs:Math.abs(refStart-targetStart),completionGapMs:Math.abs(Date.parse(referenceObs.finishedAt)-Date.parse(targetObs.finishedAt)),complete:referenceObs.validity!=="error"&&targetObs.validity!=="error",reference:referenceObs,target:targetObs};
}
async function executeOne(ep:Endpoint,challenge:Challenge):Promise<Observation>{
  reserve(ep.provider.name);
  const startedAt=new Date().toISOString();
  try{
    const response=await adapterFor(ep.provider.protocol).complete({baseUrl:ep.provider.baseUrl,apiKey:keys[ep.provider.name],model:ep.model,system:challenge.system,user:challenge.user,temperature:1,maxTokens:16,disableReasoning:true,headers:ep.provider.headers,timeoutMs:60_000});
    account(ep.provider.name,response);
    const cell=PAMELA_BATTERY.find(value=>value.id===challenge.cellId)!;const normalized=normalizePamelaAnswer(cell,response.text);
    return {provider:ep.provider.name,endpointRole:ep.role,model:ep.model,challengeId:challenge.id,family:challenge.family,block:challenge.block,cellId:challenge.cellId,repetition:challenge.repetition,requestHash:challenge.hash,startedAt,finishedAt:new Date().toISOString(),latencyMs:response.latencyMs,validity:normalized.validity,category:normalized.category,responseModel:response.responseModel,reasoningDisabled:response.reasoningDisabled,usage:response.usage};
  }catch(error:any){if(error instanceof BudgetExceededError)throw error;return {provider:ep.provider.name,endpointRole:ep.role,model:ep.model,challengeId:challenge.id,family:challenge.family,block:challenge.block,cellId:challenge.cellId,repetition:challenge.repetition,requestHash:challenge.hash,startedAt,finishedAt:new Date().toISOString(),validity:"error",errorCategory:classifyError(error),error:redact(error?.message??String(error))};}
}
class BudgetExceededError extends Error {}
function reserve(provider:string){const c=counters[provider]??={requests:0,inputTokens:0,outputTokens:0};if(c.requests>=REQUEST_LIMITS[provider])throw new BudgetExceededError(`${provider} request budget exhausted`);c.requests++;}
function account(provider:string,response:OneWordResponse){const c=counters[provider];c.inputTokens+=response.usage?.inputTokens??0;c.outputTokens+=response.usage?.outputTokens??0;if(c.inputTokens>INPUT_TOKEN_LIMITS[provider])throw new BudgetExceededError(`${provider} input token stop limit exceeded after the latest completed request`);if(c.outputTokens>OUTPUT_TOKEN_LIMITS[provider])throw new BudgetExceededError(`${provider} output token stop limit exceeded after the latest completed request`);}
function makeBlockChallenges(family:string,cells:string[],block:number,count:number,phase:string){const result:Challenge[]=[];for(let i=0;i<count;i++){const cellId=cells[(i+block)%cells.length];result.push(makeChallenge(family,phase,cellId,block,i));}return result;}
function makeCellChallenges(family:string,cells:string[],repetitions:number,phase:string){return cells.flatMap((cellId,cellIndex)=>Array.from({length:repetitions},(_,rep)=>makeChallenge(family,phase,cellId,cellIndex,rep)));}
function makeChallenge(family:string,phase:string,cellId:string,block:number,repetition:number):Challenge{const cell=PAMELA_BATTERY.find(value=>value.id===cellId);if(!cell)throw new Error(`unknown cell ${cellId}`);const nonce=hash(`${BATCH_ID}:${family}:${phase}:${block}:${repetition}`).slice(0,10);const system=pamelaSystemPrompt(cell.language);const user=`${cell.prompt}\n\nRequest marker: ${nonce}. The marker has no semantic meaning; ignore it.`;return{id:`${family}:${block}:${repetition}:${nonce}`,family,block,cellId,repetition,system,user,hash:hash(`${system}\0${user}`)}}
function summarizeCase(caseId:string,phase:string){const values=pairs.filter(value=>value.caseId===caseId&&value.phase===phase);const distances=distanceByCells(values.flatMap(value=>[value.reference]),values.flatMap(value=>[value.target]));const blocks=[...new Set(values.map(value=>value.block))].map(block=>({block,...distanceByCells(values.filter(value=>value.block===block).map(value=>value.reference),values.filter(value=>value.block===block).map(value=>value.target))}));return{caseId,phase,pairs:values.length,completePairs:values.filter(value=>value.complete).length,startGapP50:percentile(values.map(value=>value.startGapMs),.5),startGapP95:percentile(values.map(value=>value.startGapMs),.95),...distances,blocks};}
function summarizeInternal(model:string,family:string){const values=observations.filter(value=>value.family===family);const left=values.filter(value=>value.repetition%2===0),right=values.filter(value=>value.repetition%2===1);return{model,samples:values.length,...distanceByCells(left,right),quality:quality(values)};}
function summarizeNegative(model:string,family:string){const values=observations.filter(value=>value.family===family);return{model,samples:values.length,quality:quality(values)};}
function buildDevelopmentSummary(){const internal=Object.fromEntries(phases.internal.map((value:any)=>[value.model,value]));const fingerprints:Record<string,any>={};for(const model of ["cx/gpt-5.5","cx/gpt-5.6-sol","cx/gpt-5.4","cx/gpt-5.4-mini","cx/gpt-5.6-luna"]){const values=observations.filter(value=>value.model===model&&(value.endpointRole==="internal"||value.endpointRole==="negative"));fingerprints[model]=fingerprint(values);}
 const negatives=[{target:"cx/gpt-5.5",other:"cx/gpt-5.4"},{target:"cx/gpt-5.5",other:"cx/gpt-5.4-mini"},{target:"cx/gpt-5.6-sol",other:"cx/gpt-5.6-luna"}].map(item=>({ ...item,...compareFingerprints(fingerprints[item.target],fingerprints[item.other]) }));return{internal,negatives,note:"Descriptive development ranges only; not a 1% error-rate calibration artifact."};}
function distanceByCells(left:Observation[],right:Observation[]){return compareFingerprints(fingerprint(left),fingerprint(right));}
function fingerprint(values:Observation[]){const cells:Record<string,CellDistribution>={};for(const cellId of [...new Set(values.map(value=>value.cellId))]) cells[cellId]=empiricalDistribution(values.filter(value=>value.cellId===cellId).map(value=>value.validity==="error"?{validity:"error" as const}:{raw:value.category??"",token:value.category??"",category:value.category,validity:value.validity as any}));return cells;}
function compareFingerprints(left:Record<string,CellDistribution>,right:Record<string,CellDistribution>){const cellIds=[...new Set([...Object.keys(left),...Object.keys(right)])];const cells=cellIds.flatMap(cellId=>{const a=left[cellId],b=right[cellId];if(!a||!b||a.nValid<2||b.nValid<2)return[];return[{cellId,jsd:jsDivergence(a.probs,b.probs),nLeft:a.nValid,nRight:b.nValid}]});return{score:cells.length?cells.reduce((sum,value)=>sum+value.jsd,0)/cells.length:null,comparableCells:cells.length,totalCells:cellIds.length,cells};}
function quality(values:Observation[]){return{requests:values.length,valid:values.filter(value=>value.validity==="valid").length,invalid:values.filter(value=>value.validity==="invalid").length,errors:values.filter(value=>value.validity==="error").length,protocolDegraded:values.filter(value=>value.reasoningDisabled===false).length,responseModels:Object.fromEntries([...new Set(values.map(value=>value.responseModel??"missing"))].map(model=>[model,values.filter(value=>(value.responseModel??"missing")===model).length])),latencyP50:percentile(values.map(value=>value.latencyMs).filter(Number.isFinite) as number[],.5),latencyP95:percentile(values.map(value=>value.latencyMs).filter(Number.isFinite) as number[],.95)}}
function checkpoint(){mkdirSync(OUTPUT.substring(0,OUTPUT.lastIndexOf("/")),{recursive:true,mode:0o700});writeFileSync(`${OUTPUT}.partial`,JSON.stringify({batchId:BATCH_ID,counters,phases,pairs,observations},null,2)+"\n",{mode:0o600});}
function progress(label:string){const total=Object.values(counters).reduce((sum,value)=>sum+value.requests,0);if(total%40===0)console.log(JSON.stringify({phase:label,totalRequests:total,counters}));}
function percentile(values:number[],p:number){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]}
function hash(value:string){return createHash("sha256").update(value).digest("hex")}
function classifyError(error:any){const status=error?.status;return status===401||status===403?"auth":status===429?"rate_limit":status>=500?"server":status===408||/timed out/i.test(error?.message??"")?"timeout":"other"}
function redact(value:string){return value.replace(/Bearer\s+[^\s"']+/gi,"Bearer [redacted]").replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._-]{8,}\b/gi,"[redacted]").slice(0,500)}
function seededRandom(seed:string){let state=2166136261;for(const c of seed)state=Math.imul(state^c.charCodeAt(0),16777619);return()=>{state+=0x6D2B79F5;let t=state;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
function shuffle<T>(values:T[],random:()=>number){for(let i=values.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[values[i],values[j]]=[values[j],values[i]]}}

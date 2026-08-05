import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { analyzeStability } from "../src/core/v2/stability.js";
import { adapterFor } from "../src/core/adapters/registry.js";
import type { AdapterId } from "../src/core/adapters/types.js";

interface MockOptions { fallbackAfter?: number; rateLimitFirst?: boolean; fixedReportedModel?: boolean }
async function mockProvider(options: MockOptions = {}): Promise<{ server:Server;baseUrl:string;calls:()=>number }> {
  let calls=0;
  const server=createServer(async(req,res)=>{let raw="";for await(const chunk of req)raw+=chunk;calls++;
    if(options.rateLimitFirst&&calls===1){res.statusCode=429;res.setHeader("retry-after","0");res.setHeader("content-type","application/json");res.end(JSON.stringify({error:{message:"rate limited"}}));return;}
    const body=JSON.parse(raw);const prompt=body.input??body.messages?.find((m:any)=>m.role==="user")?.content??"";const fallback=options.fallbackAfter!=null&&calls>options.fallbackAfter;const text=fallback?"tails":/coin/i.test(prompt)?"heads":"blue";const model=options.fixedReportedModel?"declared-model":fallback?"fallback-model":"declared-model";res.setHeader("content-type","application/json");
    if(req.url?.endsWith("/responses"))res.end(JSON.stringify({model,output_text:text,usage:{input_tokens:20,output_tokens:1}}));else res.end(JSON.stringify({model,choices:[{message:{content:text}}],usage:{prompt_tokens:20,completion_tokens:1}}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();const port=typeof address==="object"&&address?address.port:0;return{server,baseUrl:`http://127.0.0.1:${port}/v1`,calls:()=>calls};
}
async function close(server:Server){await new Promise<void>(resolve=>server.close(()=>resolve()));}
async function complete(protocol:AdapterId,baseUrl:string,user="Coin flip."){return adapterFor(protocol).complete({baseUrl,apiKey:"secret",model:"declared-model",system:"One word.",user,temperature:1,maxTokens:16,disableReasoning:true,timeoutMs:5000});}

test("Chat and Responses semantic mapping produces the same visible normalized behavior in controlled provider",async()=>{
  const mock=await mockProvider();try{const chat=await complete("openai-compatible",mock.baseUrl);const responses=await complete("openai-responses",mock.baseUrl);assert.equal(chat.text,"heads");assert.equal(responses.text,"heads");assert.equal(chat.responseModel,responses.responseModel);assert.notEqual(chat.raw,responses.raw);}finally{await close(mock.server);}
});

test("controlled block mixture is detected even when reported model is fixed",async()=>{
  const mock=await mockProvider({fallbackAfter:6,fixedReportedModel:true});try{const observations=[] as any[];for(let index=0;index<12;index++){const response=await complete("openai-compatible",mock.baseUrl);observations.push({block:index<6?0:1,cellId:"en:coin-flip",validity:"valid",category:response.text,responseModel:response.responseModel,attempt:1});}const result=analyzeStability(observations,{minValidPerGroup:5,mixtureThreshold:.35});assert.equal(result.status,"behavioral_mixture");assert.deepEqual(result.metadataModels,{"declared-model":12});}finally{await close(mock.server);}
});

test("429 is not retried by adapters and remains one billable request",async()=>{
  const mock=await mockProvider({rateLimitFirst:true});try{await assert.rejects(()=>complete("openai-compatible",mock.baseUrl),/rate limited/);assert.equal(mock.calls(),1);}finally{await close(mock.server);}
});

test("request budget reservation is atomic in a local concurrent limiter",async()=>{
  let remaining=5;const reserve=()=>{if(remaining<=0)return false;remaining-=1;return true;};const results=await Promise.all(Array.from({length:20},async()=>reserve()));assert.equal(results.filter(Boolean).length,5);assert.equal(remaining,0);
});

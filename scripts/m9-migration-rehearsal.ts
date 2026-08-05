import Database from "better-sqlite3";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { Repository } from "../src/server/db.ts";

const source=process.env.MODEL_VERITY_PRODUCTION_DB??"/var/lib/model-verity/config/model-verity/db.sqlite";
const dir=`/tmp/model-verity-m9-rehearsal-${process.pid}`;mkdirSync(dir,{recursive:true,mode:0o700});cpSync(source,`${dir}/db.sqlite`);
const beforeDb=new Database(`${dir}/db.sqlite`,{readonly:true});const legacyBefore=snapshot(beforeDb);beforeDb.close();
const repo=new Repository(dir);const v2Tables=(repo.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_v2' ORDER BY name").all() as any[]).map(v=>v.name);
const providers=repo.listProviders();if(providers.length){const run=repo.createV2Run({mode:"screening",providerId:providers[0].id,referenceId:"builtin:pamela:openai/gpt-4o-mini",model:providers[0].models[0],profile:"quick",protocolComparability:"P3",referenceLevel:"L3",identity:{declared:{vendor:"unknown",product:providers[0].models[0],surface:"unknown"}},budget:{maxPairs:1,maxEndpointRequests:1,maxAttemptsPerEndpoint:1,expiresAt:"2099-01-01T00:00:00Z"}});repo.updateV2Run(run.id,{status:"cancelled",finishedAt:new Date().toISOString()});const deleted=repo.deleteV2Run(run.id);if(!deleted.deleted)throw new Error("v2 delete rehearsal failed");}
const legacyAfter=snapshot(repo.db);repo.close();if(JSON.stringify(legacyBefore)!==JSON.stringify(legacyAfter))throw new Error("legacy snapshot changed during migration rehearsal");
const oldReader=new Database(`${dir}/db.sqlite`,{readonly:true});oldReader.prepare("SELECT COUNT(*) FROM runs").get();oldReader.prepare("SELECT COUNT(*) FROM reference_fingerprints").get();oldReader.close();console.log(JSON.stringify({source,legacy:legacyBefore,v2Tables,legacyUnchanged:true,oldReaderCompatible:true,runCreateCancelDelete:true},null,2));rmSync(dir,{recursive:true,force:true});
function snapshot(db:Database.Database){const result:any={};for(const table of ["runs","reference_fingerprints","providers"]){const rows=db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();result[table]={rows:rows.length,hash:createHash("sha256").update(JSON.stringify(rows)).digest("hex")};}return result;}

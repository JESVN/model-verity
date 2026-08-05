import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderRecord } from "./db.js";

export interface EndpointBinding {
  endpointDisplay:string;
  endpointHash:string;
  configRevision:string;
  credentialScopeHash:string;
}

export class ReportBindingStore {
  private readonly file:string;
  constructor(private readonly dataDir:string){this.file=join(dataDir,"report-binding.key");}
  bind(provider:ProviderRecord,credential:string,model:string,protocol:string):EndpointBinding {
    const config=this.config(provider,model,protocol);
    const credentialScopeHash=createHmac("sha256",this.key()).update(JSON.stringify({providerId:provider.id,endpointHash:config.endpointHash,credential:createHash("sha256").update(credential).digest("hex")})).digest("hex");
    return{...config,credentialScopeHash};
  }
  config(provider:ProviderRecord,model:string,protocol:string):Omit<EndpointBinding,"credentialScopeHash"> {
    const parsed=new URL(provider.baseUrl);const endpointDisplay=`${parsed.origin}${parsed.pathname.replace(/\/+$/,"")}`;const endpointHash=createHash("sha256").update(endpointDisplay).digest("hex");const configRevision=createHash("sha256").update(JSON.stringify({providerId:provider.id,endpointHash,protocol,model,headers:sorted(provider.headers),updatedAt:provider.updatedAt})).digest("hex");return{endpointDisplay,endpointHash,configRevision};
  }
  private key():Buffer { mkdirSync(this.dataDir,{recursive:true,mode:0o700});if(!existsSync(this.file))writeFileSync(this.file,randomBytes(32),{mode:0o600,flag:"wx"});chmodSync(this.file,0o600);return readFileSync(this.file); }
}
function sorted(value:Record<string,string>):Record<string,string>{return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));}

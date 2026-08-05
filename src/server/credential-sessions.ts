import { randomUUID } from "node:crypto";

interface CredentialSession { id:string; runId?:string; endpointRole:"reference"|"target"; secret:string; createdAt:string; expiresAt:string }

export class CredentialSessionStore {
  private sessions=new Map<string,CredentialSession>();
  create(input:{runId?:string;endpointRole:"reference"|"target";secret:string;ttlMs?:number}):Omit<CredentialSession,"secret"> { this.cleanup();const id=randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+(input.ttlMs??15*60_000)).toISOString();this.sessions.set(id,{...input,id,createdAt,expiresAt});return{id,runId:input.runId,endpointRole:input.endpointRole,createdAt,expiresAt}; }
  bind(id:string,runId:string):void { const value=this.require(id);value.runId=runId; }
  get(id:string,runId:string,role:"reference"|"target"):string|undefined { this.cleanup();const value=this.sessions.get(id);return value&&value.runId===runId&&value.endpointRole===role?value.secret:undefined; }
  delete(id:string):void { this.sessions.delete(id); }
  deleteRun(runId:string):void { for(const [id,value] of this.sessions)if(value.runId===runId)this.sessions.delete(id); }
  clear():void { this.sessions.clear(); }
  count():number { this.cleanup();return this.sessions.size; }
  private require(id:string):CredentialSession { this.cleanup();const value=this.sessions.get(id);if(!value)throw new Error("credential session unavailable or expired");return value; }
  private cleanup():void { const now=Date.now();for(const [id,value] of this.sessions)if(Date.parse(value.expiresAt)<=now)this.sessions.delete(id); }
}

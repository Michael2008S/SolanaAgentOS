import { parseAutonomousJob,type AutonomousJob,type AutonomousAction } from './autonomous-loop.js';
import type { AutonomousTenant } from './autonomous-controller.js';
import { ExternalMcp } from './external-mcp.js';
import { mcpExecutionScope } from './mcp-execution-scope.js';
export class SharedMcpExecutor {
 private readonly running=new Map<string,{scope:string;promise:ReturnType<ExternalMcp['execute']>}>();
 constructor(private readonly client:ExternalMcp,private readonly tenants:readonly AutonomousTenant[],private readonly chain:{program:string;genesis:string},private readonly validate:(job:AutonomousJob,action:AutonomousAction,intentId:string)=>Promise<void>){}
 catalog(){return this.client.catalog();}
 discoveryStatus(){return this.client.discoveryStatus();}
 private scope(value:unknown,intentId:string){
  const job=parseAutonomousJob(value),tenant=this.tenants.find(value=>value.tenant===job.tenant),intent=job.intents.find(value=>value.id===intentId),action=intent?.action;
  if(!tenant||!intent||!action||!action.tool.startsWith('mcp:')||action.asset!=='SOL'||action.amount!=='0'||job.program!==this.chain.program||job.genesis!==this.chain.genesis||job.agent!==tenant.agent||job.session!==tenant.session||job.limits.tools.some(tool=>!tenant.limits.tools.includes(tool))||!job.limits.tools.includes(action.tool)||BigInt(job.limits.sol)>BigInt(tenant.limits.sol)||BigInt(job.limits.usdc)>BigInt(tenant.limits.usdc)||job.limits.maxCycles>tenant.limits.maxCycles||job.limits.maxActions>tenant.limits.maxActions||job.limits.maxModelRequests>tenant.limits.maxModelRequests)throw new Error('Shared MCP scope differs from its configured delegation.');
  return {job,action,scopeHash:mcpExecutionScope(job,action)};
 }
 async execute(value:unknown,intentId:string){
  const {job,action,scopeHash}=this.scope(value,intentId),intent=job.intents.find(value=>value.id===intentId)!;
  if(intent.phase!=='reserved'||job.state!=='executing')throw new Error('Shared MCP execution requires its original reserved action.');
  const key=job.tenant+':'+job.id+':'+intentId,old=this.running.get(key);
  if(old){if(old.scope!==scopeHash)throw new Error('Running MCP intent cannot change authorization.');return {scopeHash,receipt:await old.promise};}
  if(this.running.size>=100)throw new Error('Shared MCP execution capacity is full.');
  const promise=this.client.execute(job,action,intentId,(job,action,intentId)=>this.validate(job,action,intentId));this.running.set(key,{scope:scopeHash,promise});
  try{return {scopeHash,receipt:await promise};}finally{if(this.running.get(key)?.promise===promise)this.running.delete(key);}
 }
 async reconcile(value:unknown,intentId:string){const {job,scopeHash}=this.scope(value,intentId);return {scopeHash,receipt:await this.client.reconcile(job,intentId)};}
}

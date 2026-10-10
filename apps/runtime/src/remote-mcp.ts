import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { readResponseTextLimited } from './http-limits.js';
import { mcpDiscoverySnapshotSchema } from './mcp-discovery.js';
import { mcpExecutionScope } from './mcp-execution-scope.js';
import type { AutonomousJob,AutonomousAction,AutonomousReceipt } from './autonomous-loop.js';
const receiptSchema=z.object({id:z.string().max(160),output:z.string().max(65536),outputHash:z.string().regex(/^[a-f0-9]{64}$/),verified:z.literal(true),outcome:z.enum(['success','error']).optional()}).strict();
const envelopeSchema=z.object({scopeHash:z.string().regex(/^[a-f0-9]{64}$/),receipt:receiptSchema.nullable()}).strict();
export class RemoteMcp {
 private readonly origin:URL;
 constructor(endpoint:string,private readonly token:string,private readonly transport:typeof fetch=fetch){
  this.origin=new URL(endpoint);
  if(this.origin.pathname!=='/'||this.origin.username||this.origin.password||this.origin.search||this.origin.hash||!(this.origin.protocol==='https:'||this.origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(this.origin.hostname))||!/^[A-Za-z0-9_-]{24,256}$/.test(token))throw new Error('Shared MCP requires a fixed HTTPS origin or loopback and a separate operator credential.');
 }
 private async request(path:string,body?:unknown){
  const response=await this.transport(new URL('/mcp/'+path,this.origin),{method:body===undefined?'GET':'POST',redirect:'error',cache:'no-store',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},signal:AbortSignal.timeout(55000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok){await response.body?.cancel();throw new Error('Shared MCP returned HTTP '+response.status);}
  const raw=await readResponseTextLimited(response,path==='catalog'?8_000_000:400_000,'Shared MCP response exceeds its limit.');
  if(raw.includes(this.token))throw new Error('Shared MCP echoed its protected credential.');const value=JSON.parse(raw);if(JSON.stringify(value).includes(this.token))throw new Error('Shared MCP echoed its protected credential.');return value;
 }
 async catalog(){return z.array(z.object({id:z.string().regex(/^mcp:[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_.-]{1,64}$/),description:z.string().max(8000),prices:z.object({SOL:z.literal('0'),USDC:z.literal('0')}).strict()}).strict()).max(1000).parse(await this.request('catalog'));}
 async discoveryStatus(){return mcpDiscoverySnapshotSchema.parse(await this.request('discovery'));}
 private async call(job:AutonomousJob,intentId:string,reconcile:boolean){
  job=structuredClone(job);const intent=job.intents.find(value=>value.id===intentId);if(!intent)throw new Error('Unknown original MCP intent.');
  const expectedScope=mcpExecutionScope(job,intent.action);
  const value=envelopeSchema.parse(await this.request(reconcile?'reconcile':'execute',{job:{...job,intents:job.intents.map(({receipt,...intent})=>intent),answer:undefined},intentId}));
  if(value.scopeHash!==expectedScope)throw new Error('Shared MCP returned another authorization scope.');
  if(!value.receipt)return null;const receipt=value.receipt,output=z.object({source:z.string(),assurance:z.enum(['authenticated-mcp-response','local-mcp-preflight']),dispatched:z.boolean().optional(),result:z.object({isError:z.boolean().optional(),content:z.array(z.unknown()).optional(),structuredContent:z.record(z.string(),z.unknown()).optional()}).passthrough().refine(value=>value.content!==undefined||value.structuredContent!==undefined)}).passthrough().parse(JSON.parse(receipt.output));
  if(JSON.stringify(output).includes(this.token))throw new Error('Shared MCP echoed its protected credential.');
  if(receipt.id!=='mcp:'+intentId||receipt.outputHash!==createHash('sha256').update(receipt.output).digest('hex')||output.source!==intent.action.tool||!['authenticated-mcp-response','local-mcp-preflight'].includes(output.assurance)||output.assurance==='local-mcp-preflight'&&(output.dispatched!==false||output.result?.isError!==true)||(output.result?.isError===true)!==(receipt.outcome==='error'))throw new Error('Shared MCP original response or error assurance differs.');
  return receipt as AutonomousReceipt;
 }
 async execute(job:AutonomousJob,action:AutonomousAction,intentId:string){const intent=job.intents.find(value=>value.id===intentId);if(!intent||JSON.stringify(intent.action)!==JSON.stringify(action)||intent.phase!=='reserved'||action.asset!=='SOL'||action.amount!=='0')throw new Error('Shared MCP differs from its original reservation.');const receipt=await this.call(job,intentId,false);if(!receipt)throw new Error('Shared MCP original result is unavailable.');return receipt;}
 reconcile(job:AutonomousJob,intentId:string){return this.call(job,intentId,true);}
}

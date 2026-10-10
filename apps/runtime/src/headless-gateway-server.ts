import { HeadlessWorkerTool } from './headless-worker-tool.js';
import { workerToolPaymentProfiles } from './worker-tool-payment.js';
import { createServer,type IncomingMessage } from 'node:http';
import { createHash,timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { generateKeyPairSigner,address,getAddressEncoder,getProgramDerivedAddress,type TransactionPartialSigner } from '@solana/kit';
import * as z from 'zod/v4';
import { parseHeadlessTenantScopes,type AutonomousTenant } from './autonomous-controller.js';
import { HeadlessJudgeRecord } from './headless-judge-record.js';
import { HeadlessJudgeSettlement } from './headless-judge-settlement.js';
import { judgeSettlementProfiles } from './judge-settlement-protocol.js';
import { HeadlessTaskCompletion } from './headless-task-completion.js';
import { taskCompletionProfiles } from './task-completion-protocol.js';
import { judgeRecordProfiles } from './judge-record-protocol.js';
import { HeadlessWorkerDelivery,workerDeliveryProfiles } from './headless-worker-delivery.js';
import { HeadlessSkillExecutor } from './headless-executor.js';
import { HeadlessJournal } from './headless-journal.js';
import { readResponseTextLimited } from './http-limits.js';
import { runtimeNetwork,assertRuntimeNetwork } from './chain-network.js';
import { loadRuntimeEnv } from './local-provider.js';
import { redactModelError } from './model-diagnostics.js';
import { createVaultTransitSigner,vaultTransitConfigSchema } from './vault-transit-signer.js';
import { ExternalMcp,parseExternalMcpServers } from './external-mcp.js';
import { SharedMcpExecutor } from './shared-mcp-executor.js';
import { parseStandardTools,standardToolTerms } from './standard-tools.js';

loadRuntimeEnv();
const token=process.env.AGENTOS_EXECUTION_GATEWAY_TOKEN?.trim();
if(!token||!/^[A-Za-z0-9_-]{24,256}$/.test(token))throw new Error('Configure a separate headless gateway access credential.');
const expected=createHash('sha256').update(token).digest();
const program=address(process.env.AGENTOS_PROGRAM_ID?.trim()||''),endpoint=new URL(process.env.SOLANA_RPC_URL?.trim()||'https://api.devnet.solana.com');
async function rpc(method:string,params:unknown[]){
 const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const value=JSON.parse(await readResponseTextLimited(response,1_000_000,'Headless RPC response exceeds its limit.'));
 if(!response.ok||value.error)throw new Error('Headless RPC request failed: '+method);return value.result;
}
const genesis=await rpc('getGenesisHash',[]);assertRuntimeNetwork(endpoint,genesis);
const scopes=parseHeadlessTenantScopes(process.env.AGENTOS_HEADLESS_TENANTS?.trim()||'');
const toolsInput=z.array(z.object({skill:z.string().min(32).max(44),endpoint:z.string().url().max(2000)}).strict()).max(100).parse(JSON.parse(process.env.AGENTOS_HEADLESS_TOOLS?.trim()||'[]'));
if(new Set(toolsInput.map(tool=>tool.skill)).size!==toolsInput.length)throw new Error('Headless tool endpoints must be unique.');
const recoverSkillResponses=z.array(z.string().min(32).max(44)).max(100).refine(values=>new Set(values).size===values.length).parse(JSON.parse(process.env.AGENTOS_HEADLESS_SKILL_RESPONSE_RECOVERY?.trim()||'[]'));
const standardTools=parseStandardTools(process.env.AGENTOS_STANDARD_HTTP_TOOLS?.trim()||'[]');
for(const tool of standardTools)standardToolTerms(tool,runtimeNetwork().cluster,genesis);
// Protected mode fails closed: it never substitutes a new memory key.
const mode=z.enum(['memory','vault-transit']).parse(process.env.AGENTOS_HEADLESS_WALLET_MODE??'memory');
const protectedConfig=mode==='vault-transit'?z.object({feePayer:vaultTransitConfigSchema,tenants:z.record(z.string(),vaultTransitConfigSchema)}).strict().parse(JSON.parse(process.env.AGENTOS_HEADLESS_VAULT_SIGNERS??'{}')):undefined;
if(protectedConfig&&(Object.keys(protectedConfig.tenants).length!==scopes.length||scopes.some(scope=>!Object.hasOwn(protectedConfig.tenants,scope.tenant))))throw new Error('Vault signer configuration must exactly cover the configured tenants.');
const feePayer=protectedConfig?await createVaultTransitSigner(protectedConfig.feePayer):await generateKeyPairSigner(),signers=new Map<string,TransactionPartialSigner>(),tenants:AutonomousTenant[]=[];
const publicIdentities:{tenant:string;agent:string;session:string;sessionKey:string}[]=[];
for(const scope of scopes){
 const signer=protectedConfig?await createVaultTransitSigner(protectedConfig.tenants[scope.tenant]):await generateKeyPairSigner();
 if(signer.address===feePayer.address||[...signers.values()].some(other=>other.address===signer.address))throw new Error('Tenant session keys and the fee payer must be distinct.');
 signers.set(scope.tenant,signer);
 const [session]=await getProgramDerivedAddress({programAddress:program,seeds:[Buffer.from('session'),getAddressEncoder().encode(address(scope.agent)),getAddressEncoder().encode(signer.address)]});
 tenants.push({...scope,session,tokenSha256:createHash('sha256').update(scope.tenant).digest('hex')});
 publicIdentities.push({tenant:scope.tenant,agent:scope.agent,session,sessionKey:signer.address});
}
const journal=new HeadlessJournal(resolve(process.env.AGENTOS_HEADLESS_JOURNAL_PATH?.trim()||'apps/runtime/.data/headless.sqlite'));
const mcpServers=parseExternalMcpServers(process.env.AGENTOS_EXTERNAL_MCP_SERVERS?.trim()||'[]');
const mcpJournal=mcpServers.length?new HeadlessJournal(resolve(process.env.AGENTOS_HEADLESS_MCP_JOURNAL_PATH?.trim()||'apps/runtime/.data/headless-external-mcp.sqlite')):undefined;
const mcpTools=new Map(mcpServers.flatMap(server=>server.tools.map(tool=>['mcp:'+server.id+':'+tool,server.endpoint] as const)));
const judgeProfiles=judgeRecordProfiles.parse(JSON.parse(process.env.AGENTOS_HEADLESS_JUDGE_RECORDS?.trim()||'[]'));
const judgeJournal=judgeProfiles.length?new HeadlessJournal(resolve(process.env.AGENTOS_HEADLESS_JUDGE_JOURNAL_PATH?.trim()||'apps/runtime/.data/headless-judge.sqlite')):undefined;
const judgeRecord=judgeJournal?new HeadlessJudgeRecord({program,genesis,rpc,feePayer,signers,identities:tenants,profiles:judgeProfiles,journal:judgeJournal}):undefined;
const settlementProfiles=judgeSettlementProfiles.parse(JSON.parse(process.env.AGENTOS_HEADLESS_JUDGE_SETTLEMENTS?.trim()||'[]'));
const settlementJournal=settlementProfiles.length?new HeadlessJournal(resolve(process.env.AGENTOS_HEADLESS_JUDGE_SETTLEMENT_JOURNAL_PATH?.trim()||'apps/runtime/.data/headless-judge-settlement.sqlite')):undefined;
const judgeSettlement=settlementJournal?new HeadlessJudgeSettlement({program,genesis,rpc,feePayer,identities:tenants,profiles:settlementProfiles,journal:settlementJournal}):undefined;
const completionProfiles=taskCompletionProfiles.parse(JSON.parse(process.env.AGENTOS_HEADLESS_TASK_COMPLETIONS?.trim()||'[]'));
const completionJournal=completionProfiles.length?new HeadlessJournal(resolve(process.env.AGENTOS_HEADLESS_TASK_COMPLETION_JOURNAL_PATH?.trim()||'apps/runtime/.data/headless-task-completion.sqlite')):undefined;
const taskCompletion=completionJournal?new HeadlessTaskCompletion({program,genesis,network:runtimeNetwork().cluster==='localnet'?'localnet:'+genesis:'devnet',rpc,feePayer,signers,identities:tenants,profiles:completionProfiles,journal:completionJournal}):undefined;
const workerProfiles=workerDeliveryProfiles.parse(JSON.parse(process.env.AGENTOS_HEADLESS_WORKER_DELIVERIES?.trim()||'[]'));
const workerJournal=workerProfiles.length?new HeadlessJournal(resolve(process.env.AGENTOS_HEADLESS_WORKER_JOURNAL_PATH?.trim()||'apps/runtime/.data/headless-worker-delivery.sqlite')):undefined;
const workerDelivery=workerJournal?new HeadlessWorkerDelivery({program,genesis,rpc,feePayer,signers,identities:tenants,profiles:workerProfiles,journal:workerJournal}):undefined;
const workerToolProfiles=workerToolPaymentProfiles.parse(JSON.parse(process.env.AGENTOS_HEADLESS_WORKER_TOOLS?.trim()||'[]'));
const workerToolJournal=workerToolProfiles.length?new HeadlessJournal(resolve(process.env.AGENTOS_HEADLESS_WORKER_TOOL_JOURNAL_PATH?.trim()||'apps/runtime/.data/headless-worker-tools.sqlite')):undefined;
const workerTool=workerToolJournal?new HeadlessWorkerTool({program,genesis,rpc,feePayer,signers,identities:tenants,profiles:workerToolProfiles,journal:workerToolJournal}):undefined;
const executor=new HeadlessSkillExecutor({program,genesis,rpc,feePayer,signers,tenants,mcpTools,tools:new Map(toolsInput.map(tool=>[tool.skill,tool.endpoint])),standardTools:new Map(standardTools.map(tool=>[tool.id,tool])),recoverSkillResponses:new Set(recoverSkillResponses),journal});
const sharedMcp=mcpJournal?new SharedMcpExecutor(new ExternalMcp(mcpServers,mcpJournal,fetch,true,(job,action,intentId)=>executor.validateMcp(job,action,intentId)),tenants,{program,genesis},(job,action,intentId)=>executor.validateMcp(job,action,intentId)):undefined;
async function body(request:IncomingMessage){
 if(request.headers['content-type']?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw new Error('Use application/json.');
 let size=0;const chunks:Buffer[]=[];for await(const chunk of request){const data=Buffer.from(chunk);size+=data.length;if(size>8_000_000)throw new Error('Headless request exceeds its limit.');chunks.push(data);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
const server=createServer(async(request,response)=>{
 response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Cache-Control','no-store');
 const authorization=request.headers.authorization;
 if(request.rawHeaders.filter((_value,index)=>index%2===0&&request.rawHeaders[index].toLowerCase()==='authorization').length!==1||typeof authorization!=='string'||authorization.length>280||!authorization.startsWith('Bearer ')||!timingSafeEqual(createHash('sha256').update(authorization.slice(7)).digest(),expected)){
  response.writeHead(401).end(JSON.stringify({error:'Headless gateway credentials required.'}));return;
 }
 const path=new URL(request.url??'/','http://localhost').pathname;
  try{
  if(taskCompletion&&request.method==='POST'&&request.url==='/task/complete'){response.end(JSON.stringify(await taskCompletion.execute(await body(request))));return;}
  if(judgeSettlement&&request.method==='POST'&&request.url==='/judge/settle'){response.end(JSON.stringify(await judgeSettlement.execute(await body(request))));return;}
  if(judgeRecord&&request.method==='POST'&&request.url==='/judge/preflight'){response.end(JSON.stringify(await judgeRecord.preflight(await body(request))));return;}
  if(judgeRecord&&request.method==='POST'&&request.url==='/judge/record'){response.end(JSON.stringify(await judgeRecord.execute(await body(request))));return;}
  if(workerTool&&request.method==='POST'&&request.url==='/worker/tool/preflight'){response.end(JSON.stringify(await workerTool.preflight(await body(request))));return;}
  if(workerTool&&request.method==='POST'&&request.url==='/worker/tool/execute'){response.end(JSON.stringify(await workerTool.execute(await body(request))));return;}
  if(workerDelivery&&request.method==='POST'&&request.url==='/worker/deliver'){response.end(JSON.stringify(await workerDelivery.execute(await body(request))));return;}
  if(sharedMcp&&request.method==='GET'&&request.url==='/mcp/discovery'){response.end(JSON.stringify(sharedMcp.discoveryStatus()));return;}
  if(sharedMcp&&request.method==='GET'&&request.url==='/mcp/catalog'){response.end(JSON.stringify(await sharedMcp.catalog()));return;}
  if(sharedMcp&&request.method==='POST'&&['/mcp/execute','/mcp/reconcile'].includes(request.url??'')){
   const input=z.object({job:z.unknown(),intentId:z.string().uuid()}).strict().parse(await body(request));
   const value=path==='/mcp/execute'?await sharedMcp.execute(input.job,input.intentId):await sharedMcp.reconcile(input.job,input.intentId);response.end(JSON.stringify(value));return;
  }
  if(request.method==='GET'&&path==='/identity'){response.end(JSON.stringify({program,genesis,network:runtimeNetwork().identity,feePayer:feePayer.address,identities:publicIdentities,walletMode:mode==='memory'?'non-exportable-process-memory':'vault-transit-ed25519',restartRequiresNewDelegation:mode==='memory'}));return;}
  if(request.method==='POST'&&['/execute','/recover'].includes(path)){
   const input=z.object({intentId:z.string().uuid(),job:z.unknown(),action:z.object({key:z.string(),tool:z.string(),input:z.string(),asset:z.enum(['SOL','USDC']),amount:z.string()}).strict()}).strict().parse(await body(request));
   // Work continues even if the HTTP caller closes its socket while waiting.
   const result=path==='/recover'?await executor.recoverResult(input.job,input.action,input.intentId):await executor.execute(input.job,input.action,input.intentId);if(!result){response.writeHead(404).end(JSON.stringify({error:'Original paid response is not available for recovery.'}));return;}response.end(JSON.stringify(result));return;
  }
  const match=/^\/results\/([A-Za-z0-9_-]{1,80})\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(path);
  if(request.method==='GET'&&match){const result=await executor.reconcileResult(match[1],z.string().uuid().parse(match[2]),z.string().uuid().parse(match[3]));if(result){response.end(JSON.stringify(result));return;}response.writeHead(404).end(JSON.stringify({error:'Original result is not yet available.'}));return;}
  response.writeHead(404).end(JSON.stringify({error:'Headless route not found.'}));
 }catch(cause){response.writeHead(422).end(JSON.stringify({error:redactModelError(cause instanceof Error?cause.message:'Headless execution failed.')}));}
});
const port=z.coerce.number().int().min(1024).max(65535).parse(process.env.AGENTOS_HEADLESS_PORT??8790);
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'headless-gateway',port,feePayer:feePayer.address,identities:publicIdentities,restartRequiresNewDelegation:mode==='memory'})));
process.once('exit',()=>{journal.close();mcpJournal?.close();workerJournal?.close();workerToolJournal?.close();judgeJournal?.close();settlementJournal?.close();completionJournal?.close();});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { LocalHarness, digest, hex } from '../tests/local/harness.mts';
import * as sdk from '../apps/web/src/lib/agentOs.ts';
import { localModelEnvironment } from './local-launch-options.mjs';
import { readResponseTextLimited } from '../apps/runtime/src/http-limits.ts';
import { redactModelError } from '../apps/runtime/src/model-diagnostics.ts';
if(process.argv.length!==3||process.argv[2]!=='--run')throw new Error('Use --run for authorized real-model two-cycle acceptance.');
const quotaPath=resolve('docs/evidence/deepseek-goal-20261009-quota.json');
const budget=JSON.parse(await readFile(quotaPath,'utf8')),before=budget.requests.length;
assert.ok(Number.isInteger(budget.limit)&&budget.limit>0&&budget.limit<=100);assert.ok(before<=budget.limit-3,'Three authorized requests are required; no model request sent.');
const modelEnv=localModelEnvironment({realModel:true,fixtureMode:false},process.env,parseEnv(await readFile('apps/runtime/.env','utf8')));
assert.equal(modelEnv.AGENTOS_MODEL_PROVIDER,'deepseek');
const directory=resolve('docs/evidence/real-autonomous-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory);
const report:any={status:'running',modelRequestsBefore:before,transactions:[],scope:'Real DeepSeek + actual Runtime + official MCP transport + live official public Solana documentation on isolated Localnet.',limitations:['API Agent and Session use ephemeral in-memory signers, no user wallet or Devnet.','Two simulated setup transactions; research tools are free, not a new paid-tool acceptance.','The accounts document is exposed first; the fee-document tool becomes available after the first tool call, to exercise evidence-driven re-planning.','Tool-output hashes prove integrity, not factual correctness.']};
const h=new LocalHarness();let toolCalls=0,sends=0,accountsRead=false;
const sources=new Map<string,{url:string;sha256:string;excerpt:string;bytes:number}>();
const handler=createMcpHandler(()=>{const server=new McpServer({name:'official-public-source-acceptance',version:'1.0.0'});
 const register=(topic:string)=>server.registerTool('read_'+topic,{description:'Read the captured live official Solana '+topic+' document. Input is {}. Returns source URL, full document SHA-256 and a marked excerpt.',inputSchema:z.object({}).strict()},async()=>{
  const source=sources.get(topic);assert.ok(source);toolCalls++;if(topic==='accounts')accountsRead=true;
  return {content:[{type:'text',text:JSON.stringify({topic,...source,excerptOnly:true})}]};
 });register('accounts');if(accountsRead)register('fees');return server;},{responseMode:'json'});
const server=createServer(toNodeHandler(handler));
try{
 for(const endpoint of ['http://127.0.0.1:19899','http://127.0.0.1:19787/api/health']){try{await fetch(endpoint,{signal:AbortSignal.timeout(2000)});throw new Error('Isolated acceptance port occupied; existing service preserved.');}catch(cause){if((cause as Error).message.includes('occupied'))throw cause;}}
 for(const topic of ['accounts','fees']){
  const url=`https://raw.githubusercontent.com/solana-foundation/solana-com/main/apps/docs/content/docs/en/core/${topic==='accounts'?'accounts/account-structure.mdx':'fees/index.mdx'}`;
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);
  const raw=await readResponseTextLimited(response,64000,'Official source exceeds its limit.');
  const fields=['lamports','data','owner','executable','rent_epoch'];
  let excerpt:string;
  if(topic==='accounts'){
   const rows=raw.split('\n').filter(line=>line.startsWith('|')&&fields.some(field=>line.includes('mention:'+field)));
   assert.equal(rows.length,5,'Source must contain all five field definitions before billing models.');excerpt=rows.join('\n');
  }else{
   assert.ok(raw.includes('## Key facts'),'Official source changed; stop before billing models.');
   const paragraph=raw.split('## Key facts')[0].split('---').at(-1)!.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,350);
   const facts=raw.slice(raw.indexOf('## Key facts')).split('## Limits')[0].replace(/<[^>]+>/g,'').trim();excerpt=paragraph+'\n'+facts;
  }
  assert.ok(excerpt.length<=1100,'Complete evidence excerpt exceeds the model context budget; stop before billing.');
  sources.set(topic,{url,sha256:hex(digest(raw)),excerpt,bytes:Buffer.byteLength(raw)});await writeFile(join(directory,topic+'-source.mdx'),raw);
 }
 server.listen(0,'127.0.0.1');await once(server,'listening');const listener=server.address();assert.ok(listener&&typeof listener!=='string');
 await h.start();h.approved=true;const rpc=h.rpc.bind(h);h.rpc=(method,params=[])=>{if(method==='sendTransaction')assert.ok(++sends<=2);return rpc(method,method==='sendTransaction'?[params[0],{...(params[1] as object),maxRetries:30}]:params);};
 for(let n=0;n<150;n++){if(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32)break;await new Promise(resolve=>setTimeout(resolve,200));}
 const {payer,session}=h.signers,init=await sdk.buildInitializeAgent(payer.address,'Real autonomous research',0.001,0.001,0.001,0.001,['api']),agent=init.accounts;
 const delegation=await sdk.buildCreateSession(payer.address,agent.agent,agent.policy,session.address,BigInt(Math.floor(Date.now()/1000)+1800),0.001,0.001,0.001,0.001,['api']);
 await h.tx('initialize API Agent',[init.instruction]);await h.tx('create API-only Session',[delegation.instruction]);
 const token='real-autonomous-local-acceptance-device-20261010',profile={tenant:'owner',tokenSha256:hex(digest(token)),agent:agent.agent,session:delegation.session,maxDurationSeconds:900,
  limits:{sol:'0',usdc:'0',maxCycles:2,maxActions:2,maxModelRequests:3,tools:['mcp:official:read_accounts','mcp:official:read_fees']}};
 Object.assign(process.env,modelEnv,{AGENTOS_MODEL_REQUEST_LIMIT:String(budget.limit),AGENTOS_MODEL_BUDGET_PATH:quotaPath,AGENTOS_MODEL_DIAGNOSTICS_PATH:join(directory,'model-diagnostics.jsonl'),
  AGENTOS_AUTONOMOUS_COMBINED_EVALUATION:'true',AGENTOS_AUTONOMOUS_TENANTS:JSON.stringify([profile]),AGENTOS_AUTONOMOUS_DATABASE_PATH:join(h.root,'real-autonomous.sqlite'),
  AGENTOS_EXTERNAL_MCP_SERVERS:JSON.stringify([{id:'official',endpoint:`http://127.0.0.1:${listener.port}/mcp`,tools:['read_accounts','read_fees']}]),
  AGENTOS_AUTONOMOUS_NOTIFICATIONS:'[]',AGENTOS_STANDARD_HTTP_TOOLS:'[]',AGENTOS_EXECUTION_GATEWAY:'',AGENTOS_PUBLIC_PORT:'',AGENTOS_SERVICE_CATALOG_URL:'',AGENTOS_SERVICE_CATALOG_URLS:'[]'});
 await h.runtime();
 const api=async(path:string,body?:unknown)=>{const r=await fetch(h.runtimeUrl+'/api/autonomous/'+path,{headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const result=JSON.parse(await readResponseTextLimited(r,1_000_000,'Job response exceeds its limit.'));assert.ok(r.ok,'Autonomous API failed');return result;};
 const created=await api('jobs',{goal:'Research public Solana documentation in order: first obtain the accounts source, then obtain the fees source. Do not complete until both distinct official-source receipts exist. Explain the five account fields and the base versus prioritization fee distinction using only those receipts, and cite both source URLs and receipt IDs. If fee evidence is missing, give specific feedback and select the available fee tool in the next plan. Paraphrase, quote at most 10 words per source, and disclose excerpt limits.'});
 report.jobId=created.job.id;report.genesis=h.genesis;report.agent=agent.agent;report.session=delegation.session;
 let job:any;
 for(let n=0;n<240;n++){job=(await api('jobs/'+created.job.id)).job;if(['completed','failed','needs_reconciliation','cancelled'].includes(job.state))break;await new Promise(resolve=>setTimeout(resolve,1000));}
 await writeFile(join(directory,'job.json'),JSON.stringify(job,null,2)+'\n');
 assert.equal(job.state,'completed');assert.equal(job.cycle,2);assert.equal(job.modelRequests,3);assert.equal(job.intents.length,2);assert.equal(toolCalls,2);assert.deepEqual(job.spent,{sol:'0',usdc:'0'});
 assert.equal(job.evaluations[0].complete,false);assert.equal(job.evaluations[1].complete,true);assert.ok(job.evaluations[0].feedback.trim());
 assert.deepEqual(job.intents.map((intent:any)=>intent.action.tool),profile.limits.tools);
 for(const intent of job.intents){assert.equal(intent.phase,'complete');assert.equal(hex(digest(intent.receipt.output)),intent.receipt.outputHash);assert.ok(job.answer.includes(intent.receipt.id),'Answer must attribute both actual receipts.');}
 const definitionChecks=[/lamports[\s\S]{0,200}(balance|SOL|units)/i,/data[\s\S]{0,200}(state|byte|code)/i,/owner[\s\S]{0,200}(program|write)/i,/executable[\s\S]{0,200}(program|code|boolean)/i,/rent_epoch[\s\S]{0,200}(deprecated|legacy|unused)/i];
 assert.ok(definitionChecks.every(pattern=>pattern.test(job.answer)),'Answer does not cover every requested field definition; model completion alone is insufficient.');
 const after=JSON.parse(await readFile(quotaPath,'utf8')).requests.length;assert.equal(after-before,3);assert.ok(after<=budget.limit);
 await h.restartRuntime();await api('jobs/'+job.id+'/resume',{});const reopened=(await api('jobs/'+job.id)).job;assert.deepEqual(reopened,job);assert.equal(toolCalls,2);assert.equal(JSON.parse(await readFile(quotaPath,'utf8')).requests.length,after);
 await writeFile(join(directory,'sources.json'),JSON.stringify(Object.fromEntries(sources),null,2)+'\n');
 Object.assign(report,{status:'passed',modelRequestsAfter:after,realModelRequests:3,cycles:2,toolCalls,missingEvidenceTriggeredReplan:true,completedRestartNoReplay:true});
}catch(cause){report.status='failed';report.error=redactModelError(cause instanceof Error?cause.message:'Acceptance failed');process.exitCode=1;}
finally{
 for(const item of h.transactions as {signature:string}[]){try{for(let n=0;n<200;n++){const state=(await h.rpc('getSignatureStatuses',[[item.signature],{searchTransactionHistory:true}])).value[0];if(state?.confirmationStatus==='finalized')break;await new Promise(resolve=>setTimeout(resolve,100));}const tx=await h.rpc('getTransaction',[item.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);assert.ok(tx&&tx.meta.err===null&&tx.meta.fee<=10000);const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,item.signature+'.json'),raw);report.transactions.push({signature:item.signature,sha256:hex(digest(raw)),fee:tx.meta.fee});}catch{report.transactionAuditIncomplete=true;}}
 if(report.transactionAuditIncomplete)report.status='failed';
 report.modelRequestsAfter=JSON.parse(await readFile(quotaPath,'utf8')).requests.length;report.totalTransactions=sends;report.toolCalls=toolCalls;await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
 server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await handler.close();if(h.root)await h.finish(report.status==='passed'?undefined:'Real autonomous acceptance failed');console.log(JSON.stringify({status:report.status,evidence:directory}));
}

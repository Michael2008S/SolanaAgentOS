import assert from 'node:assert/strict';
import { createServer,type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { LocalHarness,digest,hex } from './harness.mts';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
import { HeadlessJournal } from '../../apps/runtime/src/headless-journal.ts';
import { HeadlessSkillExecutor } from '../../apps/runtime/src/headless-executor.ts';
import { getAddressEncoder } from '@solana/kit';
import type { ChildProcess } from 'node:child_process';
const vaultRestart=process.argv[2]==='--vault-restart',cachedResponse=process.argv[2]==='--cached-response',asset=cachedResponse&&process.argv.includes('--usdc')?'USDC':'SOL';
if(process.argv.length>(cachedResponse?4:3)||process.argv.length<3||(!vaultRestart&&!cachedResponse&&process.argv[2]!=='--run'))throw new Error('Use --run or --vault-restart for isolated Localnet headless acceptance.');
const h=new LocalHarness(),servers:Server[]=[];
const directory=resolve('docs/evidence/'+(cachedResponse?'autonomous-skill-cache-'+asset.toLowerCase()+'-':vaultRestart?'autonomous-vault-restart-':'autonomous-headless-')+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(directory,{recursive:false});
const report:any={status:'running',network:'isolated-localnet',model:'local-protocol-fixture',limitations:['Tests actual paid chain execution with deterministic local model/tool responses; does not prove real-model re-planning quality.','In-memory signers survive browser closure, not gateway process termination.'],transactions:[]};
if(vaultRestart)report.limitations=['Uses a local Vault protocol fixture with non-exportable keys; does not validate a deployed Vault or hardware protection.','Tests deterministic local model/tool responses, not real-model re-planning quality.'];
let journal:HeadlessJournal|undefined,sends=0,models=0,executions=0,cachedReads=0,dropResponse=cachedResponse,allowCacheRecovery=!cachedResponse,cacheRuntimeRestarted=false;
let releaseSecondPlan:()=>void=()=>{},gatewayProcess:ChildProcess|undefined,gatewayGeneration=0,gatewayRestarted=false;
const secondPlanBarrier=new Promise<void>(resolve=>{releaseSecondPlan=resolve;});
const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
const quotaPath=resolve('docs/evidence/deepseek-goal-20261009-quota.json'),quotaBefore=await readFile(quotaPath,'utf8');
async function listen(server:Server,port:number){servers.push(server);server.listen(port,'127.0.0.1');await once(server,'listening');}
async function json(req:AsyncIterable<unknown>){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));return JSON.parse(Buffer.concat(chunks).toString());}
try{
 await h.start();h.approved=true;
 const original=h.rpc.bind(h),captured=new Set<string>();
 h.rpc=async(method,params=[])=>{
  if(method==='sendTransaction'){assert.ok(++sends<=12);params=[params[0],{...(params[1] as object),maxRetries:30}];}
  const result=await original(method,params);
  if(method==='getSignatureStatuses')for(const [index,status] of result.value.entries())if(status?.confirmationStatus==='finalized'){
   const signature=(params[0] as string[])[index];if(captured.has(signature))continue;
   const tx=await original('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
   if(tx){captured.add(signature);const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,signature+'.json'),raw);report.transactions.push({signature,slot:tx.slot,fee:tx.meta.fee,sha256:hex(digest(raw))});await save();}
  }
  return result;
 };
 for(let n=0;n<150;n++){if(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32)break;await new Promise(resolve=>setTimeout(resolve,200));}
 const {payer,session,provider}=h.signers;
 const init=await sdk.buildInitializeAgent(payer.address,'Autonomous headless fixture',0.01,0.001,0.01,0.001,['api']),agent=init.accounts;
 const permitted=await sdk.buildCreateSession(payer.address,agent.agent,agent.policy,session.address,BigInt(Math.floor(Date.now()/1000)+1800),0.001,0.002,0.001,0.002,['api']);
 const resource='http://127.0.0.1:19791/fixture';
 const skill=await sdk.buildRegisterSkill(provider.address,digest('autonomous-local-fixture'),digest(resource),0.001,asset==='USDC'?'0.001':'0');
 await h.tx('initialize autonomous Agent',[init.instruction]);await h.tx('fund autonomous Vault',[await sdk.buildDeposit(payer.address,agent.agent,agent.vault,0.002)]);
 if(asset==='USDC')await h.tx('fund autonomous USDC Vault',[await sdk.buildDepositUsdc(payer.address,agent.agent,'0.002')]);
 await h.tx('create autonomous API Session',[permitted.instruction]);await h.tx('fund autonomous fixture Provider',[sdk.buildFundSessionFeeReserve(payer.address,provider.address,0.02)]);
 await h.tx('register autonomous fixture Skill',[skill.instruction],[provider]);
 // Planning reads the finalized catalog; setup confirmation alone is insufficient.
 for(let n=0;n<200;n++){const account=(await h.rpc('getAccountInfo',[skill.skill,{encoding:'base64',commitment:'finalized'}])).value;if(account){const data=Buffer.from(account.data[0],'base64');assert.equal(data.readBigUInt64LE(114),asset==='USDC'?1000n:0n);break;}assert.ok(n<199,'Skill registration did not finalize');await new Promise(resolve=>setTimeout(resolve,200));}
 if(cachedResponse)report.cachedIdentity={feePayer:payer.address,identities:[{tenant:'owner',agent:agent.agent,session:permitted.session,sessionKey:session.address}]};
 const {createAgentOsVaultSkillHandler}=await import('../../apps/runtime/src/x402-vault.ts');
 const {localClaimExecution}=await import('../../apps/runtime/src/local-provider.ts');const {localSkillResultStore}=await import('../../apps/runtime/src/skill-result-store.ts');
 const handler=createAgentOsVaultSkillHandler({programId:sdk.PROGRAM_ADDRESS,skill:skill.skill,resourceUrl:resource,allowedOrigins:['http://127.0.0.1:15173'],rpcUrl:h.rpcUrl,
  claimExecution:localClaimExecution('autonomous-fixture'),resultStore:localSkillResultStore('autonomous-fixture',sdk.PROGRAM_ADDRESS),execute:async({prompt})=>{executions++;return {kind:'local-protocol-fixture',source:executions,prompt,fact:executions===1?'First source':'Independent second source'};}});
 await listen(createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await handler(new Request(resource,{method:req.method,headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));const body=await response.text();if(req.headers['agentos-result-only']==='true')cachedReads++;if(dropResponse&&req.headers['payment-signature']&&response.status===200){dropResponse=false;res.destroy();return;}res.writeHead(response.status,Object.fromEntries(response.headers)).end(body);}catch{res.writeHead(500).end();}}),19791);
 const modelServer=createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer local-test-fixture');const body=await json(req),context=JSON.parse(body.input[1].content);models++;
  if(vaultRestart&&models===3)await secondPlanBarrier;
  const value=body.text.format.name==='agentos_autonomous_plan'?{actions:[{tool:skill.skill,asset,input:context.cycle===1?'Find first source':'Find independent second source'}]}:
   {complete:context.priorActions.length===2,feedback:context.priorActions.length===2?'Both sources obtained':'Need an independent second source',answer:context.priorActions.length===2?'LOCAL FIXTURE: two verified sources answer the goal.':''};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}));}catch{res.writeHead(500).end();}});
 await listen(modelServer,0);const modelAddress=modelServer.address();assert.ok(modelAddress&&typeof modelAddress!=='string');process.env.AGENTOS_LOCAL_MODEL_URL=`http://127.0.0.1:${modelAddress.port}/v1/responses`;
 const deviceToken='local-owner-device-test-token-20261009',gatewayToken='local-headless-gateway-test-token-20261009';
 const profile={tenant:'owner',tokenSha256:hex(digest(deviceToken)),agent:agent.agent,session:permitted.session,maxDurationSeconds:600,
  limits:{sol:asset==='SOL'?'2000000':'0',usdc:asset==='USDC'?'2000':'0',maxCycles:3,maxActions:2,maxModelRequests:6,tools:[skill.skill]}};
 if(!vaultRestart){journal=new HeadlessJournal(join(h.root,'gateway.sqlite'));
 const executor=new HeadlessSkillExecutor({program:sdk.PROGRAM_ADDRESS,genesis:h.genesis,rpc:h.rpc.bind(h),feePayer:payer,signers:new Map([['owner',session]]),tenants:[profile],tools:new Map([[skill.skill,resource]]),recoverSkillResponses:cachedResponse?new Set([skill.skill]):undefined,journal});
 await listen(createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer '+gatewayToken);const path=new URL(req.url!,'http://localhost').pathname;
  if(req.method==='POST'){const body=await json(req);if(path==='/recover'&&!allowCacheRecovery){res.writeHead(503).end('{}');return;}res.end(JSON.stringify(await (path==='/recover'?executor.recoverResult(body.job,body.action,body.intentId):executor.execute(body.job,body.action,body.intentId))));return;}
  const parts=path.split('/'),result=executor.result(parts[2],parts[3],parts[4]);if(result)res.end(JSON.stringify(result));else res.writeHead(404).end();
 }catch(cause){res.writeHead(422).end(JSON.stringify({error:cause instanceof Error?cause.message:'Failed'}));}}),19788);
 }
 const gatewayIdentity=async()=>{
  const response=await fetch('http://127.0.0.1:19788/identity',{headers:{authorization:'Bearer '+gatewayToken}});assert.ok(response.ok);return response.json() as Promise<any>;
 };
 const launchGateway=async()=>{
  const child=await h.launch('gateway-'+(++gatewayGeneration),process.execPath,['--import','tsx','apps/runtime/src/headless-gateway-server.ts'],{
   AGENTOS_HEADLESS_PORT:'19788',SOLANA_RPC_URL:'http://127.0.0.1:19790',AGENTOS_HEADLESS_WALLET_MODE:'vault-transit',
   AGENTOS_EXECUTION_GATEWAY_TOKEN:gatewayToken,AGENTOS_HEADLESS_JOURNAL_PATH:join(h.root,'gateway.sqlite'),
   AGENTOS_HEADLESS_TENANTS:JSON.stringify([{tenant:profile.tenant,agent:profile.agent,maxDurationSeconds:profile.maxDurationSeconds,limits:profile.limits}]),
   AGENTOS_HEADLESS_TOOLS:JSON.stringify([{skill:skill.skill,endpoint:resource}]),FIXTURE_VAULT_TOKEN:'local-vault-fixture-token',
   AGENTOS_HEADLESS_VAULT_SIGNERS:JSON.stringify({feePayer:{endpoint:'http://127.0.0.1:19792',key:'payer',version:1,address:payer.address,tokenEnv:'FIXTURE_VAULT_TOKEN'},tenants:{owner:{endpoint:'http://127.0.0.1:19792',key:'session',version:1,address:session.address,tokenEnv:'FIXTURE_VAULT_TOKEN'}}}),
  });
  for(let n=0;n<100;n++){try{const identity=await gatewayIdentity();assert.equal(identity.feePayer,payer.address);assert.equal(identity.identities[0].session,permitted.session);assert.equal(identity.restartRequiresNewDelegation,false);return child;}catch(cause){if(child.exitCode!==null||child.signalCode!==null||n===99)throw cause;await new Promise(resolve=>setTimeout(resolve,100));}}
  throw new Error('Gateway startup timed out.');
 };
 if(vaultRestart){
  // Capture all child RPC effects, while the fixture wallet stays outside the gateway process.
  await listen(createServer(async(req,res)=>{try{const body=await json(req);const result=await h.rpc(body.method,body.params);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value));}catch{res.writeHead(500).end();}}),19790);
  await listen(createServer(async(req,res)=>{try{
   assert.equal(req.headers['x-vault-token'],'local-vault-fixture-token');const match=/^\/v1\/transit\/(keys|sign)\/(payer|session)$/.exec(req.url!);assert.ok(match);const signer=match[2]==='payer'?payer:session;
   let data:unknown;
   if(match[1]==='keys')data={type:'ed25519',derived:false,exportable:false,allow_plaintext_backup:false,supports_signing:true,min_encryption_version:0,keys:{'1':{public_key:Buffer.from(getAddressEncoder().encode(signer.address)).toString('base64')}}};
   else{const body=await json(req);assert.equal(body.key_version,1);assert.equal(body.prehashed,false);data={signature:'vault:v1:'+Buffer.from(await crypto.subtle.sign('Ed25519',signer.keyPair.privateKey,Buffer.from(body.input,'base64'))).toString('base64')};}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({data}));
  }catch{res.writeHead(422).end();}}),19792);
  gatewayProcess=await launchGateway();report.originalIdentity=await gatewayIdentity();
 }
 Object.assign(process.env,{AGENTOS_AUTONOMOUS_TENANTS:JSON.stringify([profile]),AGENTOS_AUTONOMOUS_DATABASE_PATH:join(h.root,'autonomous.sqlite'),
  AGENTOS_EXECUTION_GATEWAY:'http://127.0.0.1:19788',AGENTOS_EXECUTION_GATEWAY_TOKEN:gatewayToken,AGENTOS_EXECUTION_FEE_PAYER:payer.address});
 await h.runtime();
 const call=async(path:string,body?:unknown)=>{const response=await fetch(h.runtimeUrl+'/api/autonomous/'+path,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{authorization:'Bearer '+deviceToken,'content-type':'application/json'}});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value as any;};
 const created=await call('jobs',{goal:'Use two independent local fixture sources to answer the public research question.'});
 report.jobId=created.job.id;report.creationResponseCompleted=true;await save();
 // No persistent browser/socket participates after this 202 response.
 let job:any;
 for(let n=0;n<300;n++){
  if(vaultRestart&&models===3&&!gatewayRestarted){
   assert.equal(executions,1);assert.equal(sends,7);assert.ok(gatewayProcess);
   gatewayProcess.kill('SIGTERM');await once(gatewayProcess,'exit');gatewayProcess=await launchGateway();
   report.restartedIdentity=await gatewayIdentity();assert.deepEqual(report.restartedIdentity,report.originalIdentity);
   gatewayRestarted=true;releaseSecondPlan();
  }
  const snapshot=await call('jobs/'+created.job.id);job=snapshot.job;if(cachedResponse&&(job.state==='needs_reconciliation'||snapshot.error&&executions===1)&&!cacheRuntimeRestarted){assert.equal(executions,1);assert.equal(cachedReads,0);await h.restartRuntime();allowCacheRecovery=true;cacheRuntimeRestarted=true;await call('jobs/'+created.job.id+'/resume',{});continue;}if(job.state==='completed')break;if(snapshot.error&&!cachedResponse||['failed',...(cachedResponse?[]:['needs_reconciliation'])].includes(job.state)){report.diagnostics=snapshot.error??job.state;await save();throw new Error('Autonomous flow stopped; see report.');}await new Promise(resolve=>setTimeout(resolve,500));}
 assert.equal(job.state,'completed');assert.equal(job.cycle,2);assert.equal(job.spent.sol,asset==='SOL'?'2000000':'0');assert.equal(job.spent.usdc,asset==='USDC'?'2000':'0');assert.equal(models,4);assert.equal(executions,2);assert.equal(sends,asset==='USDC'?10:9);if(asset==='SOL')assert.equal(await h.sol(agent.vault),0n);
 assert.deepEqual(job.intents.map((intent:any)=>intent.executionId),['0','1']);assert.ok(job.intents.every((intent:any)=>intent.phase==='complete'&&intent.receipt.verified));
 const notifications=await call('events');assert.equal(notifications.events.at(-1).state,'completed');
 await writeFile(join(directory,'completed-job.json'),JSON.stringify(job,null,2)+'\n');await writeFile(join(directory,'events.json'),JSON.stringify(notifications,null,2)+'\n');
 await h.restartRuntime();assert.equal((await call('jobs/'+job.id)).job.state,'completed');await call('jobs/'+job.id+'/resume',{});await new Promise(resolve=>setTimeout(resolve,300));assert.equal(sends,asset==='USDC'?10:9);assert.equal(models,4);assert.equal(executions,2);
 assert.equal(await readFile(quotaPath,'utf8'),quotaBefore);
 if(vaultRestart)assert.equal(gatewayRestarted,true);
 if(cachedResponse){assert.equal(cacheRuntimeRestarted,true);assert.equal(cachedReads,1);report.cachedResponseRecovery={asset,actualRuntimeRestart:true,cachedReads,toolExecutions:executions};}
 report.status='passed';Object.assign(report,{cycles:2,modelFixtureRequests:models,paidToolExecutions:executions,totalTransactions:sends,restartWithoutReplay:true,realModelQuotaUnchanged:true,closedBrowserIndependent:true,gatewayProcessRestartWithSameDelegation:gatewayRestarted});
}catch(cause){report.status='failed';report.error=cause instanceof Error?cause.message:'Failed';process.exitCode=1;
}finally{
 report.totalTransactions=sends;report.modelFixtureRequests=models;report.paidToolExecutions=executions;report.submittedSetupTransactions=h.transactions;
 for(const item of h.transactions as {signature:string}[])if(!report.transactions.some((tx:any)=>tx.signature===item.signature)){
  try{const tx=await h.rpc('getTransaction',[item.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);if(tx){const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,item.signature+'.json'),raw);report.transactions.push({signature:item.signature,slot:tx.slot,fee:tx.meta.fee,sha256:hex(digest(raw))});}}catch{}
 }
 releaseSecondPlan();await save();gatewayProcess?.kill('SIGTERM');
 for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}journal?.close();if(h.root)await h.finish(report.status==='passed'?undefined:'Autonomous headless flow failed');console.log(JSON.stringify({status:report.status,evidence:directory}));
}

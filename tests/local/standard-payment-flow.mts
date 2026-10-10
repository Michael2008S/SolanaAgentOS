import assert from 'node:assert/strict';
import { createServer,type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { compileTransaction,getBase64EncodedWireTransaction } from '@solana/kit';
import { LocalHarness,digest,hex } from './harness.mts';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
import { HeadlessJournal } from '../../apps/runtime/src/headless-journal.ts';
import { HeadlessSkillExecutor } from '../../apps/runtime/src/headless-executor.ts';
import { autonomousServiceScope } from '../../apps/runtime/src/autonomous-proof.ts';
import { parseMppAuth } from '../../apps/runtime/src/standard-payments.ts';
import { parseStandardTools } from '../../apps/runtime/src/standard-tools.ts';
import { canonicalJson } from '../../apps/runtime/src/canonical-json.ts';
const args=process.argv.slice(2),interruptBody=args.includes('--interrupt-response-body');
if(!args.includes('--run')||args.some(arg=>!['--run','--interrupt-response-body'].includes(arg)))throw new Error('Use --run [--interrupt-response-body] for isolated standard-payment acceptance.');
const h=new LocalHarness(),servers:Server[]=[],directory=resolve('docs/evidence/standard-mpp-'+(interruptBody?'response-body-':'')+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(directory);const report:any={status:'running',network:'isolated-localnet',model:'local-protocol-fixture',limitations:['MPP service fixture verifies native/SPL inner transfers; external servers may enforce different wallet acceptance policies.','Does not prove real-model quality or x402 interoperability.'],transactions:[]};
let journal:HeadlessJournal|undefined,sends=0,models=0,executions=0,cacheHits=0,recoveryEnabled=!interruptBody;
const sentSignatures=new Set<string>(),dropped=new Set<string>(),cache=new Map<string,{header:string,input:string,content:string,receipt:string}>();
const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
const quotaPath=resolve('docs/evidence/deepseek-goal-20261009-quota.json'),quotaBefore=await readFile(quotaPath,'utf8');
const encode=(value:unknown)=>Buffer.from(canonicalJson(value)).toString('base64url');
async function body(req:AsyncIterable<unknown>){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));return JSON.parse(Buffer.concat(chunks).toString());}
async function listen(server:Server,port=0){servers.push(server);server.listen(port,'127.0.0.1');await once(server,'listening');const listener=server.address();assert.ok(listener&&typeof listener!=='string');return listener.port;}
try{
 await h.start();h.approved=true;const original=h.rpc.bind(h);
 h.rpc=async(method,params=[])=>{if(method==='sendTransaction')assert.ok(++sends<=10);const result=await original(method,params);if(method==='sendTransaction')sentSignatures.add(result);return result;};
 for(let n=0;n<150;n++){if(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32)break;await new Promise(resolve=>setTimeout(resolve,200));}
 const {payer,session,provider,workerSession}=h.signers;
 const init=await sdk.buildInitializeAgent(payer.address,'Standard HTTP acceptance',0.01,0.001,0.01,0.001,['api','payment']),agent=init.accounts;
 const delegated=await sdk.buildCreateSession(payer.address,agent.agent,agent.policy,session.address,BigInt(Math.floor(Date.now()/1000)+1800),0.001,0.001,0.001,0.001,['api','payment']);
 const apiOnly=await sdk.buildCreateSession(payer.address,agent.agent,agent.policy,workerSession.address,BigInt(Math.floor(Date.now()/1000)+1800),0.001,0.001,0.001,0.001,['api']);
 await h.tx('initialize standard Agent',[init.instruction]);await h.tx('fund SOL Vault',[await sdk.buildDeposit(payer.address,agent.agent,agent.vault,0.001)]);
 await h.tx('fund USDC Vault',[await sdk.buildDepositUsdc(payer.address,agent.agent,'0.001')]);await h.tx('create payment and API Session',[delegated.instruction]);
 await h.tx('create API-only negative Session',[apiOnly.instruction]);await h.tx('fund fixture recipient',[sdk.buildFundSessionFeeReserve(payer.address,provider.address,0.01)]);
 const termsFor=(asset:string)=>({amount:asset==='SOL'?'1000000':'1000',currency:asset==='SOL'?'sol':sdk.DEVNET_USDC_MINT,recipient:provider.address,externalId:'fixture-'+asset,
  methodDetails:{network:'localnet',...(asset==='USDC'?{decimals:6,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}:{})}});
 const servicePort=await listen(createServer(async(req,res)=>{try{
  const asset=req.url==='/sol'?'SOL':'USDC',request=await body(req),auth={id:'fixture-'+asset,realm:'local-fixture',method:'solana',intent:'charge',request:encode(termsFor(asset))};
  if(!req.headers.authorization){res.writeHead(402,{'www-authenticate':'Payment '+Object.entries(auth).map(([key,value])=>key+'='+JSON.stringify(value)).join(', ')}).end();return;}
  assert.ok(req.headers.authorization.startsWith('Payment '));const credential=JSON.parse(Buffer.from(req.headers.authorization.slice(8),'base64url').toString());assert.deepEqual(credential.challenge,auth);assert.equal(credential.payload.type,'signature');
  const cacheKey=credential.payload.signature,cached=cache.get(cacheKey);if(cached){assert.equal(cached.header,req.headers.authorization);assert.equal(cached.input,JSON.stringify(request));cacheHits++;(report.cacheRetrievals??=[]).push({asset,signature:cacheKey,content:cached.content,receipt:cached.receipt,headerUnchanged:true,inputUnchanged:true});res.setHeader('payment-receipt',cached.receipt);res.end(cached.content);return;}
  const tx=await h.rpc('getTransaction',[credential.payload.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);assert.equal(tx.meta.err,null);
  const instructions=tx.meta.innerInstructions.flatMap((group:any)=>group.instructions);
  if(asset==='SOL')assert.ok(instructions.some((instruction:any)=>instruction.program==='system'&&instruction.parsed?.type==='transfer'&&instruction.parsed.info.source===agent.vault&&instruction.parsed.info.destination===provider.address&&instruction.parsed.info.lamports===1000000));
  else assert.ok(instructions.some((instruction:any)=>instruction.parsed?.type==='transferChecked'&&instruction.parsed.info.authority===agent.agent&&instruction.parsed.info.mint===sdk.DEVNET_USDC_MINT&&instruction.parsed.info.destination===providerToken&&instruction.parsed.info.tokenAmount.amount==='1000'));
  assert.ok(tx.transaction.message.instructions.some((instruction:any)=>instruction.program==='spl-memo'&&instruction.parsed==='fixture-'+asset));executions++;
  const receipt=encode({method:'solana',challengeId:auth.id,reference:credential.payload.signature,status:'success',timestamp:new Date().toISOString()}),content=JSON.stringify({publicAnswer:request.question,asset,source:'standard-mpp-fixture'});
  cache.set(cacheKey,{header:req.headers.authorization,input:JSON.stringify(request),receipt,content});res.setHeader('payment-receipt',receipt);res.end(content);
 }catch(cause){res.writeHead(422).end(JSON.stringify({error:cause instanceof Error?cause.message:'Failed'}));}}));
 const providerToken=await sdk.deriveUsdcTokenAddress(provider.address);
 const tools=parseStandardTools(JSON.stringify(['SOL','USDC'].map(asset=>({id:'http:fixture-'+asset.toLowerCase(),protocol:'mpp',...(interruptBody?{recoverResponse:true}:{}),endpoint:`http://127.0.0.1:${servicePort}/`+asset.toLowerCase(),recipient:provider.address,asset,amount:asset==='SOL'?'1000000':'1000',description:'POST JSON object with public question'}))));
 const deviceToken='standard-owner-device-token-20261010',gatewayToken='standard-gateway-test-token-20261010';
 const profile={tenant:'owner',tokenSha256:hex(digest(deviceToken)),agent:agent.agent,session:delegated.session,maxDurationSeconds:600,limits:{sol:'1000000',usdc:'1000',maxCycles:2,maxActions:2,maxModelRequests:4,tools:tools.map(tool=>tool.id)}};
 const journalPath=join(h.root,'standard-gateway.sqlite');journal=new HeadlessJournal(journalPath);
 const transport:typeof fetch=async(url,init)=>{const response=await fetch(url,init);const endpoint=String(url);if(interruptBody&&response.status===200&&new Headers(init?.headers).has('authorization')&&!dropped.has(endpoint)){dropped.add(endpoint);recoveryEnabled=false;await response.body?.cancel();return new Response(new ReadableStream({start(controller){controller.error(new Error('Injected loss of original MPP response body.'));}}),{status:200,headers:response.headers});}return response;};
 const options={program:sdk.PROGRAM_ADDRESS,genesis:h.genesis,rpc:h.rpc.bind(h),feePayer:payer,signers:new Map([['owner',session]]),tenants:[profile],tools:new Map(),standardTools:new Map(tools.map(tool=>[tool.id,tool])),journal,transport};let executor=new HeadlessSkillExecutor(options);
 const gatewayPort=await listen(createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer '+gatewayToken);
  if(req.method==='POST'){const input=await body(req);const result=req.url==='/recover'?(recoveryEnabled?await executor.recoverResult(input.job,input.action,input.intentId):null):await executor.execute(input.job,input.action,input.intentId);if(result)res.end(JSON.stringify(result));else res.writeHead(404).end();return;}
  const parts=req.url!.split('/'),result=executor.result(parts[2],parts[3],parts[4]);if(result)res.end(JSON.stringify(result));else res.writeHead(404).end();
 }catch(cause){(report.gatewayErrors??=[]).push(cause instanceof Error?cause.message:'Failed');res.writeHead(422).end(JSON.stringify({error:cause instanceof Error?cause.message:'Failed'}));}}));
 const modelPort=await listen(createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer local-test-fixture');const input=await body(req);models++;
  const context=JSON.parse(input.input[1].content),remaining=tools.filter(tool=>!context.priorActions.some((intent:any)=>intent.tool===tool.id&&intent.receipt));
  const actions=remaining.map(tool=>({tool:tool.id,asset:tool.asset,input:JSON.stringify({question:'Public fixture question'})}));
  const result=input.text.format.name==='agentos_autonomous_plan'?{actions}:{complete:remaining.length===0,feedback:remaining.length?'Obtain remaining public output':'Both public outputs obtained',answer:remaining.length?'':'LOCAL FIXTURE: two paid public responses.',actions};
  res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]}));
 }catch(cause){report.modelFixtureError=cause instanceof Error?cause.message:String(cause);res.writeHead(500).end();}}));
 Object.assign(process.env,{AGENTOS_AUTONOMOUS_COMBINED_EVALUATION:'true',AGENTOS_LOCAL_MODEL_URL:`http://127.0.0.1:${modelPort}/v1/responses`,AGENTOS_AUTONOMOUS_TENANTS:JSON.stringify([profile]),AGENTOS_AUTONOMOUS_DATABASE_PATH:join(h.root,'standard-autonomous.sqlite'),AGENTOS_STANDARD_HTTP_TOOLS:JSON.stringify(tools),AGENTOS_EXECUTION_GATEWAY:`http://127.0.0.1:${gatewayPort}`,AGENTOS_EXECUTION_GATEWAY_TOKEN:gatewayToken,AGENTOS_EXECUTION_FEE_PAYER:payer.address});
 let runtime=await h.runtime();report.runtimePids=[runtime.pid];const call=async(path:string,value?:unknown)=>{const response=await fetch(h.runtimeUrl+'/api/autonomous/'+path,{...(value?{method:'POST',body:JSON.stringify(value)}:{}),headers:{authorization:'Bearer '+deviceToken,'content-type':'application/json'}});const payload=await response.json();assert.ok(response.ok,JSON.stringify(payload));return payload as any;};
 const created=await call('jobs',{goal:'Obtain two public fixture responses through standard paid HTTP APIs.'});let job:any;
 for(let n=0;n<300;n++){
  const snapshot=await call('jobs/'+created.job.id);job=snapshot.job;if(job.state==='completed')break;
  if(job.state==='needs_reconciliation'&&interruptBody&&!recoveryEnabled){
   const intent=job.intents.at(-1),original=journal.load(job.tenant,job.id,intent.id)!;assert.equal(intent.phase,'reserved');assert.ok(original.payment&&original.paymentHeader&&original.paymentChallenge);assert.equal(original.content,undefined);assert.equal(original.result,undefined);assert.equal(sends,job.intents.length===1?7:9);assert.equal(executions,job.intents.length);assert.equal(models,job.intents.length);
   await writeFile(join(directory,'interrupted-'+intent.action.asset+'-job.json'),JSON.stringify(job,null,2)+'\n');await writeFile(join(directory,'interrupted-'+intent.action.asset+'-record.json'),JSON.stringify(original,null,2)+'\n');
   (report.interruptions??=[]).push({asset:intent.action.asset,intentId:intent.id,signature:original.payment.signature,transactionsBeforeRecovery:sends,contentMissing:true,resultMissing:true});
   journal.close();journal=new HeadlessJournal(journalPath);options.journal=journal;executor=new HeadlessSkillExecutor(options);recoveryEnabled=true;
   runtime=await h.restartRuntime();report.runtimePids.push(runtime.pid);continue;
  }
  if(job.state==='needs_reconciliation'&&interruptBody&&recoveryEnabled){await new Promise(resolve=>setTimeout(resolve,500));continue;}
  if(snapshot.error||job.state==='failed')throw new Error(JSON.stringify(snapshot));await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(interruptBody){assert.equal(cacheHits,2);assert.equal(dropped.size,2);assert.equal(report.interruptions.length,2);assert.equal(new Set(report.runtimePids).size,3);assert.deepEqual(report.gatewayErrors,Array(2).fill('Injected loss of original MPP response body.'));for(const intent of job.intents)assert.equal(journal.load(job.tenant,job.id,intent.id)!.responseRecoveries,1);report.cachedResponseRecoveredWithoutPayment=true;report.actualRuntimeRestart=true;}
 assert.equal(job.state,'completed');assert.equal(sends,10);assert.equal(models,3);assert.equal(executions,2);assert.equal(await h.sol(agent.vault),0n);
 assert.equal((await h.rpc('getTokenAccountBalance',[await sdk.deriveUsdcTokenAddress(agent.agent)])).value.amount,'0');assert.equal((await h.rpc('getTokenAccountBalance',[providerToken])).value.amount,'1000');
 // The raw instruction must reject an API-only Session even if a caller bypasses Runtime validation.
 const negative={...job,session:apiOnly.session,intents:[{...job.intents[0],executionId:'2'}]},scope=await autonomousServiceScope({job:negative,action:job.intents[0].action,intentId:job.intents[0].id,sessionKey:workerSession.address,feePayer:payer.address,recipient:provider.address,endpoint:tools[0].endpoint});
 const instruction={programAddress:sdk.PROGRAM_ADDRESS,accounts:scope.accounts.map((key,index)=>({address:key,role:[2,3,1,1,1,1,1,1,0][index]})),data:scope.paymentData};
 const message=await h.message([instruction as any],[workerSession]);const simulation=(await h.rpc('simulateTransaction',[getBase64EncodedWireTransaction(compileTransaction(message)),{encoding:'base64',sigVerify:false,commitment:'confirmed'}])).value;
 assert.ok(simulation.err);assert.ok(simulation.logs.some((line:string)=>line.includes('InvalidPermission')));report.apiOnlySessionRejected=true;
 const outputs=job.intents.map((intent:any)=>executor.result(job.tenant,job.id,intent.id));await writeFile(join(directory,'gateway-outputs.json'),JSON.stringify(outputs,null,2)+'\n');await writeFile(join(directory,'completed-job.json'),JSON.stringify(job,null,2)+'\n');
 if(interruptBody)await writeFile(join(directory,'completed-gateway-records.json'),JSON.stringify(job.intents.map((intent:any)=>journal!.load(job.tenant,job.id,intent.id)),null,2)+'\n');
 report.identity={feePayer:payer.address,sessionKey:session.address,provider:provider.address,tools};report.programBuild=JSON.parse(await readFile('target/sbf-safe/build-manifest.json','utf8'));
 journal.close();journal=new HeadlessJournal(journalPath);options.journal=journal;executor=new HeadlessSkillExecutor(options);await h.restartRuntime();await call('jobs/'+job.id+'/resume',{});assert.equal((await call('jobs/'+job.id)).job.state,'completed');assert.equal(executions,2);assert.equal(sends,10);assert.equal(models,3);assert.equal(await readFile(quotaPath,'utf8'),quotaBefore);
 for(const output of outputs)for(const signature of [output.paymentSignature,output.resultSignature]){const tx=await h.rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,signature+'.json'),raw);report.transactions.push({signature,sha256:hex(digest(raw)),slot:tx.slot,fee:tx.meta.fee});}
 report.status='passed';Object.assign(report,{totalTransactions:sends,modelFixtureRequests:models,cacheHits,paidHttpCalls:executions,realModelQuotaUnchanged:true,restartWithoutReplay:true,closedBrowserIndependent:true});
}catch(cause){report.status='failed';report.error=cause instanceof Error?cause.message:'Failed';process.exitCode=1;
}finally{
 report.totalTransactions=sends;for(const signature of sentSignatures){if(report.transactions.some((item:any)=>item.signature===signature))continue;try{for(let n=0;n<200;n++){const status=(await h.rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}])).value[0];if(status?.confirmationStatus==='finalized')break;await new Promise(resolve=>setTimeout(resolve,100));}const tx=await h.rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);if(tx){const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,signature+'.json'),raw);report.transactions.push({signature:signature,sha256:hex(digest(raw)),slot:tx.slot,fee:tx.meta.fee});}}catch{}}
 await save();for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}journal?.close();if(h.root)await h.finish(report.status==='passed'?undefined:'Standard payment acceptance failed');console.log(JSON.stringify({status:report.status,evidence:directory}));
}

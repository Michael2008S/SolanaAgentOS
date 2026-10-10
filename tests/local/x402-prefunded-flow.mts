import assert from 'node:assert/strict';
import { createServer,type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir,readFile,writeFile,access } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { address,getCompiledTransactionMessageDecoder,getTransactionDecoder,getBase64EncodedWireTransaction,getBase58Decoder,type SignatureBytes } from '@solana/kit';
import { ExactSvmScheme } from '@x402/svm/exact/facilitator';
import type { FacilitatorSvmSigner } from '@x402/svm';
import { encodePaymentRequiredHeader,decodePaymentSignatureHeader,encodePaymentResponseHeader } from '@x402/core/http';
import { LocalHarness,digest,hex } from './harness.mts';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
import { HeadlessJournal } from '../../apps/runtime/src/headless-journal.ts';
import { HeadlessSkillExecutor } from '../../apps/runtime/src/headless-executor.ts';
import { DatabaseSync } from 'node:sqlite';
import { parseStandardTools } from '../../apps/runtime/src/standard-tools.ts';
const args=process.argv.slice(2),remoteCoordinator=args.includes('--remote-coordinator'),interruptModes=['--interrupt-checkpoint','--interrupt-result-broadcast','--interrupt-result-signing','--interrupt-response-body'];
if(!args.includes('--run')||args.some(arg=>!['--run','--remote-coordinator',...interruptModes].includes(arg))||args.filter(arg=>interruptModes.includes(arg)).length>1||remoteCoordinator&&!args.includes('--interrupt-response-body'))throw new Error('Use --run [one interruption mode]; --remote-coordinator requires --interrupt-response-body.');
const interruptBody=args.includes('--interrupt-response-body');let cacheHits=0;
const responseCache=new Map<string,{header:string;request:string;content:string;receipt:string}>();
const interruptSigning=args.includes('--interrupt-result-signing');const persistedResultWires=new Set<string>();let resultSignerCalls=0;
const interruptBroadcast=args.includes('--interrupt-result-broadcast'),interruptCheckpoint=args.some(arg=>interruptModes.includes(arg));let savedResultWire:string|undefined;let checkpointInterrupted=false,checkpointRecoveryEnabled=!interruptCheckpoint;
const h=new LocalHarness(),servers:Server[]=[],directory=resolve('docs/evidence/'+(remoteCoordinator?'central-x402-prefunded-':'standard-x402-prefunded-')+(interruptBody?'response-body-':interruptSigning?'result-signing-':interruptBroadcast?'result-broadcast-':interruptCheckpoint?'checkpoint-':'')+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(directory);const report:any={status:'running',network:'isolated-localnet',model:'local-protocol-fixture',sdk:'@x402/svm 2.28.0',limitations:['Opt-in Session token custody: revocation cannot recall allocated funds or already signed transfers.','SDK fee-payer isolation requires a sponsor address distinct from the recipient owner.','Fixed classic USDC mint only; does not prove real-model quality or public-network deployment.'],transactions:[]};
let journal:HeadlessJournal|undefined,centralChild:any,activeWorker:any,workerOrigin='',releaseDropped=false,sends=0,models=0,executions=0,sponsorSigns=0,defaultRejects=0;const sentSignatures=new Set<string>();
const quotaPath=resolve('docs/evidence/deepseek-goal-20261009-quota.json'),quotaBefore=await readFile(quotaPath,'utf8');
function observeJournal(current:HeadlessJournal){const save=current.save.bind(current);current.save=value=>{
 if(value.complete&&!checkpointInterrupted&&!interruptBroadcast&&!interruptSigning&&!interruptBody&&interruptCheckpoint){checkpointInterrupted=true;throw new Error('Injected interruption after finalized result and before complete checkpoint.');}
 save(value);if(value.result){if(!savedResultWire)savedResultWire=value.result.wire;persistedResultWires.add(value.result.wire);}
 if(interruptSigning&&!checkpointInterrupted&&value.content!==undefined&&!value.result){checkpointInterrupted=true;throw new Error('Injected interruption after saved paid response and before result signing.');}
};}
async function body(req:AsyncIterable<unknown>){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));return JSON.parse(Buffer.concat(chunks).toString());}
async function listen(server:Server){servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const listener=server.address();assert.ok(listener&&typeof listener!=='string');return listener.port;}
async function finalized(signature:string){for(let n=0;n<300;n++){const status=(await h.rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}])).value[0];assert.equal(status?.err??null,null);if(status?.confirmationStatus==='finalized')return status.slot;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Original transaction not finalized.');}
try{
 if(remoteCoordinator){try{await fetch('http://127.0.0.1:19791',{signal:AbortSignal.timeout(1000)});throw new Error('Central fixture port already in use.');}catch(cause){if(cause instanceof Error&&cause.message==='Central fixture port already in use.')throw cause;}}
 await h.start();h.approved=true;const original=h.rpc.bind(h);h.rpc=async(method,params=[])=>{if(interruptSigning&&method==='simulateTransaction'&&(params[1] as any).sigVerify===true){const message=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(String(params[0]),'base64')).messageBytes);if(message.version!==1&&message.instructions.some(ix=>Buffer.from(ix.data??[]).subarray(0,8).equals(Buffer.from(digest('global:record_skill_result')).subarray(0,8))))assert.ok(persistedResultWires.has(String(params[0])),'Signed result must be persisted before RPC exposure');}if(method==='sendTransaction'){if(interruptBroadcast&&!checkpointInterrupted&&params[0]===savedResultWire&&savedResultWire){checkpointInterrupted=true;throw new Error('Injected interruption before original signed result broadcast.');}assert.ok(++sends<=12);}const result=await original(method,params);if(method==='sendTransaction')sentSignatures.add(result);return result;};
 for(let n=0;n<150;n++){if(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32)break;await new Promise(resolve=>setTimeout(resolve,200));}
 const {payer,session,provider,workerSession,workerOwner}=h.signers,recipient=workerOwner.address;
 const init=await sdk.buildInitializeAgent(payer.address,'Official x402 SDK acceptance',0.001,0.001,0.002,0.002,['api','payment']),agent=init.accounts;
 const delegated=await sdk.buildCreateSession(payer.address,agent.agent,agent.policy,session.address,BigInt(Math.floor(Date.now()/1000)+1800),0.001,0.001,0.002,0.002,['api','payment']);
 await h.tx('initialize x402 Agent',[init.instruction]);await h.tx('fund USDC Vault',[await sdk.buildDepositUsdc(payer.address,agent.agent,'0.002')]);await h.tx('create x402 Session',[delegated.instruction]);
 await h.tx('fund client rent reserve',[sdk.buildFundSessionFeeReserve(payer.address,session.address,0.02)]);
 await h.tx('fund merchant fee wallet',[sdk.buildFundSessionFeeReserve(payer.address,provider.address,0.01)]);await h.tx('fund independent sponsor and prepare merchant USDC account',[sdk.buildFundSessionFeeReserve(payer.address,workerSession.address,0.01),{programAddress:address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),accounts:[{address:payer.address,role:3},{address:await sdk.deriveUsdcTokenAddress(recipient),role:1},{address:recipient,role:0},{address:sdk.DEVNET_USDC_MINT,role:0},{address:address('11111111111111111111111111111111'),role:0},{address:address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),role:0}],data:Uint8Array.of(1)}]);
 const network=`solana:${h.genesis.slice(0,32)}`,before=new Map([[provider.address,await h.sol(provider.address)],[workerSession.address,await h.sol(workerSession.address)]]),settlements:any[]=[];
 // This adapter only translates actual Localnet RPC and non-exportable Kit signing
 // into the official facilitator interface. All payment validation is SDK code.
 function signer(wallet:typeof provider):FacilitatorSvmSigner{
  const checked=(value:string)=>assert.equal(value,network);
  return {getAddresses:()=>[wallet.address],
   async signTransaction(wire,feePayer,value){checked(value);assert.equal(feePayer,wallet.address);const tx=getTransactionDecoder().decode(Buffer.from(wire,'base64'));assert.equal(tx.signatures[wallet.address],null);sponsorSigns++;
    const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',wallet.keyPair.privateKey,new Uint8Array(tx.messageBytes))) as SignatureBytes;
    return getBase64EncodedWireTransaction({...tx,signatures:{...tx.signatures,[wallet.address]:signature}});},
   async simulateTransaction(wire,value,options){checked(value);const result=await h.rpc('simulateTransaction',[wire,{encoding:'base64',sigVerify:false,commitment:'confirmed',...options}]);assert.equal(result.value.err,null,JSON.stringify(result.value));},
   async sendTransaction(wire,value){checked(value);assert.equal((await h.rpc('simulateTransaction',[wire,{encoding:'base64',sigVerify:true,commitment:'confirmed'}])).value.err,null);return h.rpc('sendTransaction',[wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:30}]);},
   async confirmTransaction(signature,value){checked(value);return {slot:await finalized(signature)};},
   async simulateTransactionWithInnerInstructions(wire,value){checked(value);const result=await h.rpc('simulateTransaction',[wire,{encoding:'base64',sigVerify:false,commitment:'confirmed',innerInstructions:true}]);assert.equal(result.value.err,null);return {innerInstructions:result.value.innerInstructions};},
   async getConfirmedTransactionInnerInstructions(signature,value){checked(value);const result=await h.rpc('getTransaction',[signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);return result?{innerInstructions:result.meta.innerInstructions}:null;},
   async getTokenAccountBalance(token,value){checked(value);try{return BigInt((await h.rpc('getTokenAccountBalance',[token])).value.amount);}catch{return null;}},
   async fetchAddressLookupTables(addresses,value){checked(value);assert.equal(addresses.length,0);return {};}};
 }
 const facilitators=[provider,workerSession].map(wallet=>({wallet,plain:new ExactSvmScheme(signer(wallet)),supported:new ExactSvmScheme(signer(wallet))}));
 let servicePort=0;
 servicePort=await listen(createServer(async(req,res)=>{try{
  const index=req.url==='/merchant'?0:1,facilitator=facilitators[index],request=await body(req),endpoint=`http://127.0.0.1:${servicePort}${req.url}`;
  const accepted={scheme:'exact',network,amount:'1000',asset:sdk.DEVNET_USDC_MINT,payTo:recipient,maxTimeoutSeconds:60,extra:{...facilitator.supported.getExtra(network),...(index===0?{memo:'merchant-public-invoice'}:{})}};
  const required={x402Version:2,resource:{url:endpoint},accepts:[accepted],...(interruptBody?{extensions:{'payment-identifier':{info:{required:true},schema:{type:'object',properties:{required:{type:'boolean'},id:{type:'string',minLength:16,maxLength:128}},required:['required']}}}}:{})};
  if(!req.headers['payment-signature']){res.writeHead(402,{'payment-required':encodePaymentRequiredHeader(required)}).end();return;}
  const payload=decodePaymentSignatureHeader(String(req.headers['payment-signature']));assert.deepEqual(payload.accepted,accepted);assert.deepEqual(payload.resource,required.resource);
  const identifier=(payload.extensions?.['payment-identifier'] as any)?.info?.id,cacheKey=req.url+':'+identifier,header=String(req.headers['payment-signature']);
  if(interruptBody){assert.match(identifier,/^pay_[a-f0-9-]{36}$/);const cached=responseCache.get(cacheKey);if(cached){assert.equal(cached.header,header);assert.equal(cached.request,JSON.stringify(request));cacheHits++;(report.cacheRetrievals??=[]).push({identifier,path:req.url,receipt:cached.receipt,content:cached.content,headerUnchanged:true});res.setHeader('payment-response',cached.receipt);res.end(cached.content);return;}}
  const negative=await facilitator.plain.verify(payload,accepted);(report.sdkChecks??=[]).push({path:req.url,default:negative});assert.equal(negative.isValid,true,JSON.stringify(negative));assert.equal(sponsorSigns,index);
  const verified=await facilitator.supported.verify(payload,accepted);report.sdkChecks.at(-1).supported=verified;assert.equal(verified.isValid,true,JSON.stringify(verified));
  const settled=await facilitator.supported.settle(payload,accepted);report.sdkChecks.at(-1).settled=settled;assert.equal(settled.success,true,JSON.stringify(settled));assert.ok(settled.transaction);executions++;settlements.push({sponsor:facilitator.wallet.address,verify:verified,settle:settled,defaultRejection:negative});
  const receipt=encodePaymentResponseHeader(settled),content=JSON.stringify({publicAnswer:request.question,source:'official-x402-sdk',sponsor:index===0?'merchant':'independent'});if(interruptBody)responseCache.set(cacheKey,{header,request:JSON.stringify(request),content,receipt});res.setHeader('payment-response',receipt);res.end(content);
 }catch(cause){const error=cause instanceof Error?cause.message:'Failed';(report.serviceErrors??=[]).push(error);res.writeHead(422).end(JSON.stringify({error}));}}));
 const tools=parseStandardTools(JSON.stringify(['merchant','independent'].map((name,index)=>({id:'http:x402-'+name,protocol:'x402',x402Mode:'prefunded',...(interruptBody?{recoverResponse:true}:{}),endpoint:`http://127.0.0.1:${servicePort}/`+(index===0?'merchant':'independent'),recipient,asset:'USDC',amount:'1000',description:'POST JSON object with public question'}))));
 const deviceToken='x402-owner-device-acceptance-test-20261010',gatewayToken='x402-gateway-acceptance-test-20261010',profile={tenant:'owner',allowSessionTokenCustody:true,tokenSha256:hex(digest(deviceToken)),agent:agent.agent,session:delegated.session,maxDurationSeconds:600,limits:{sol:'0',usdc:'2000',maxCycles:2,maxActions:2,maxModelRequests:4,tools:tools.map(tool=>tool.id)}};
 const journalPath=join(h.root,'x402-gateway.sqlite');journal=new HeadlessJournal(journalPath);observeJournal(journal);
 const sessionSigner={address:session.address,signTransactions:async(...args:Parameters<typeof session.signTransactions>)=>{for(const tx of args[0]){const message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);if(message.version!==1&&message.instructions.some(ix=>Buffer.from(ix.data??[]).subarray(0,8).equals(Buffer.from(digest('global:record_skill_result')).subarray(0,8))))resultSignerCalls++;}return session.signTransactions(...args);}};
 const transport:typeof fetch=async(url,init)=>{const response=await fetch(url,init);if(interruptBody&&!checkpointInterrupted&&response.status===200&&new Headers(init?.headers).has('payment-signature')){await response.body?.cancel();checkpointInterrupted=true;return new Response(new ReadableStream({start(controller){controller.error(new Error('Injected loss of paid response body after original settlement.'));}}),{status:200,headers:response.headers});}return response;};
 const options={transport,program:sdk.PROGRAM_ADDRESS,genesis:h.genesis,rpc:h.rpc.bind(h),feePayer:payer,signers:new Map([['owner',sessionSigner]]),tenants:[profile],tools:new Map(),standardTools:new Map(tools.map(tool=>[tool.id,tool])),journal};
 let executor=new HeadlessSkillExecutor(options);
 const gatewayPort=await listen(createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer '+gatewayToken);if(req.method==='POST'){const input=await body(req);const recovered=req.url==='/recover';const result=recovered?(checkpointRecoveryEnabled?await executor.recoverResult(input.job,input.action,input.intentId):null):await executor.execute(input.job,input.action,input.intentId);if(result)res.end(JSON.stringify(result));else res.writeHead(404).end();return;}
  const parts=req.url!.split('/'),result=checkpointRecoveryEnabled?await executor.reconcileResult(parts[2],parts[3],parts[4]):null;if(result)res.end(JSON.stringify(result));else res.writeHead(404).end();
 }catch(cause){const error=cause instanceof Error?cause.message:'Failed';(report.gatewayErrors??=[]).push(error);res.writeHead(422).end(JSON.stringify({error}));}}));
 const modelPort=await listen(createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer local-test-fixture');const input=await body(req);models++;const result=input.text.format.name==='agentos_autonomous_plan'?{actions:tools.map(tool=>({tool:tool.id,asset:tool.asset,input:JSON.stringify({question:'Public fixture question'})}))}:{complete:true,feedback:'Both standard outputs obtained',answer:'LOCAL FIXTURE: two x402 public responses.'};res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]}));}catch{res.writeHead(500).end();}}));
 Object.assign(process.env,{AGENTOS_LOCAL_MODEL_URL:`http://127.0.0.1:${modelPort}/v1/responses`,AGENTOS_AUTONOMOUS_TENANTS:JSON.stringify([profile]),AGENTOS_AUTONOMOUS_DATABASE_PATH:join(h.root,'x402-autonomous.sqlite'),AGENTOS_STANDARD_HTTP_TOOLS:JSON.stringify(tools),AGENTOS_EXECUTION_GATEWAY:`http://127.0.0.1:${gatewayPort}`,AGENTOS_EXECUTION_GATEWAY_TOKEN:gatewayToken,AGENTOS_EXECUTION_FEE_PAYER:payer.address,AGENTOS_TASK_COORDINATOR:'',AGENTOS_TASK_COORDINATOR_TOKEN:'',AGENTOS_EXTERNAL_MCP_SERVERS:'[]',AGENTOS_MCP_EXECUTION_GATEWAY:'',AGENTOS_AUTONOMOUS_NOTIFICATIONS:'[]',AGENTOS_MODEL_PROVIDER:'openai',AGENTOS_PUBLIC_PORT:''});
 const centralDatabase=join(h.root,'central-paid-jobs.sqlite'),workerDatabase=join(h.root,'must-not-create-paid-worker.sqlite'),peerDatabase=join(h.root,'must-not-create-paid-peer.sqlite'),coordinatorToken='central-paid-coordinator-fixture-credential',centralOrigin='http://127.0.0.1:19791',coordinationCommands:any[]=[];
 let peerGeneration=0;
 const stop=async(child:any,signal:NodeJS.Signals='SIGTERM')=>{if(child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.kill(signal);await exit;};
 const startCentral=async()=>{
  const child=await h.launch('paid-central-'+Date.now(),process.execPath,['--import','tsx','apps/runtime/src/autonomous-coordinator-server.ts'],{AGENTOS_COORDINATOR_TOKEN:coordinatorToken,AGENTOS_COORDINATOR_GENESIS:h.genesis,AGENTOS_COORDINATOR_PORT:'19791',AGENTOS_AUTONOMOUS_DATABASE_PATH:centralDatabase});
  for(let n=0;n<100;n++){try{const response=await fetch(centralOrigin+'/coordination',{method:'POST',headers:{authorization:'Bearer '+coordinatorToken,'content-type':'application/json'},body:JSON.stringify({op:'list',tenant:'owner'})});assert.equal(response.status,200);return child;}catch(cause){if(child.exitCode!==null||child.signalCode!==null||n===99)throw cause;await new Promise(resolve=>setTimeout(resolve,200));}}throw new Error('Central task service unavailable.');
 };
 const startPeer=async()=>{
  const child=await h.launch('paid-peer-'+(++peerGeneration),process.execPath,['--import','tsx','apps/runtime/src/index.ts'],{PORT:'19788',AGENTOS_AUTONOMOUS_DATABASE_PATH:peerDatabase,AGENTOS_DATA_DIR:join(h.root,'paid-peer-data'),AGENTOS_WEB_ORIGINS:'http://127.0.0.1:15173'});
  for(let n=0;n<100;n++){try{const response=await fetch('http://127.0.0.1:19788/api/health');assert.equal(response.status,200);workerOrigin='http://127.0.0.1:19788';return child;}catch(cause){if(child.exitCode!==null||child.signalCode!==null||n===99)throw cause;await new Promise(resolve=>setTimeout(resolve,200));}}throw new Error('Paid peer unavailable.');
 };
 if(remoteCoordinator){
  report.limitations.push('Central service and Worker processes run on one host; no production multi-host HTTPS deployment.','Paid gateway journal reopens in-process; ephemeral non-exportable signers remain in the test parent, not a production Vault.');
  centralChild=await startCentral();report.centralBeforePid=centralChild.pid;
  const proxyPort=await listen(createServer(async(req,res)=>{try{
   assert.equal(req.url,'/coordination');assert.equal(req.headers.authorization,'Bearer '+coordinatorToken);const input=await body(req);coordinationCommands.push({op:input.op,tenant:input.tenant,...(input.id?{id:input.id}:{}),...(input.hash?{hash:input.hash}:{})});
   if(input.op==='release'&&!releaseDropped){releaseDropped=true;res.writeHead(503).end('{}');return;}
   const response=await fetch(centralOrigin+'/coordination',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+coordinatorToken,'content-type':'application/json'},body:JSON.stringify(input)});res.writeHead(response.status,{'content-type':'application/json'}).end(await response.text());
  }catch(cause){report.centralProxyError=cause instanceof Error?cause.message:String(cause);res.writeHead(503).end('{}');}}));
  Object.assign(process.env,{AGENTOS_TASK_COORDINATOR:`http://127.0.0.1:${proxyPort}`,AGENTOS_TASK_COORDINATOR_TOKEN:coordinatorToken,AGENTOS_AUTONOMOUS_DATABASE_PATH:workerDatabase});
 }
 activeWorker=await h.runtime();workerOrigin=h.runtimeUrl;report.workerBeforePid=activeWorker.pid;const call=async(path:string,value?:unknown)=>{const response=await fetch(workerOrigin+'/api/autonomous/'+path,{...(value?{method:'POST',body:JSON.stringify(value)}:{}),headers:{authorization:'Bearer '+deviceToken,'content-type':'application/json'}});const payload=await response.json();assert.ok(response.ok,JSON.stringify(payload));return payload as any;};
 const created=await call('jobs',{goal:'Obtain two public responses through standard x402 paid APIs.'});let job:any;
 for(let n=0;n<300;n++){
  const snapshot=await call('jobs/'+created.job.id);job=snapshot.job;if(job.state==='completed')break;
  if(job.state==='needs_reconciliation'&&interruptCheckpoint&&checkpointInterrupted&&!checkpointRecoveryEnabled){
   assert.equal(job.intents.length,1);assert.equal(job.intents[0].phase,'reserved');assert.equal(sends,interruptBroadcast||interruptSigning||interruptBody?8:9);assert.equal(executions,1);assert.equal(sponsorSigns,1);assert.equal(models,1);
   const original=journal.load(job.tenant,job.id,job.intents[0].id)!;assert.equal(original.complete,false);assert.ok(original.funding&&original.payment);if(interruptBody)assert.equal(original.content,undefined);else assert.ok(original.content);if(interruptSigning||interruptBody){assert.equal(original.result,undefined);assert.equal(resultSignerCalls,0);}else assert.ok(original.result);
   if(!interruptSigning&&!interruptBody){if(interruptBroadcast)assert.equal((await h.rpc('getSignatureStatuses',[[original.result!.signature],{searchTransactionHistory:true}])).value[0],null);else await finalized(original.result!.signature);}
   await writeFile(join(directory,'interrupted-job.json'),JSON.stringify(job,null,2)+'\n');await writeFile(join(directory,'interrupted-gateway-record.json'),JSON.stringify(original,null,2)+'\n');
   report.checkpointInterruption={stage:interruptBody?'response-body-lost':interruptSigning?'before-result-signing':interruptBroadcast?'result-before-broadcast':'after-result-finality',stateBefore:job.state,transactionsBeforeRecovery:sends,paidHttpCallsBeforeRecovery:executions,modelCallsBeforeRecovery:models,originalResultSignature:original.result?.signature,resultSignerCallsBeforeRecovery:resultSignerCalls};
   journal.close();journal=new HeadlessJournal(journalPath);observeJournal(journal);options.journal=journal;executor=new HeadlessSkillExecutor(options);checkpointRecoveryEnabled=true;
   // Startup recovery resumes the durable reserved intent and remaining plan.
   // No manual resume, execute call or new model plan is dispatched here.
   if(remoteCoordinator){
    for(let n=0;n<100&&!releaseDropped;n++)await new Promise(resolve=>setTimeout(resolve,100));assert.equal(releaseDropped,true);
    const db=new DatabaseSync(centralDatabase);try{const row=db.prepare('SELECT token,pid,body FROM jobs WHERE tenant=? AND id=?').get(job.tenant,job.id)!;assert.ok(row.token);assert.equal(row.pid,centralChild.pid);assert.deepEqual(JSON.parse(String(row.body)),job);report.centralAgentLeaseHeldBeforeCrash=true;}finally{db.close();}
    await stop(activeWorker);await stop(centralChild,'SIGKILL');centralChild=await startCentral();report.centralAfterPid=centralChild.pid;assert.notEqual(report.centralBeforePid,report.centralAfterPid);activeWorker=await startPeer();report.workerAfterPid=activeWorker.pid;assert.notEqual(report.workerBeforePid,report.workerAfterPid);
   }else activeWorker=await h.restartRuntime();continue;
  }
  if(job.state==='needs_reconciliation'&&interruptCheckpoint&&checkpointRecoveryEnabled&&report.checkpointInterruption&&job.intents.length===1&&job.intents[0].phase==='reserved'){
   // Startup recovery can be waiting for the same signed result's finality.
   // Keep the bounded observation loop; do not dispatch another recovery/run.
   if((report.gatewayErrors?.length??0)>1)throw new Error(JSON.stringify(report.gatewayErrors));await new Promise(resolve=>setTimeout(resolve,500));continue;
  }
  if(snapshot.error||['failed','needs_reconciliation'].includes(job.state))throw new Error(JSON.stringify(snapshot));await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(interruptCheckpoint){assert.equal(checkpointInterrupted,true);assert.ok(report.checkpointInterruption);assert.deepEqual(report.gatewayErrors,[interruptBody?'Injected loss of paid response body after original settlement.':interruptSigning?'Injected interruption after saved paid response and before result signing.':interruptBroadcast?'Injected interruption before original signed result broadcast.':'Injected interruption after finalized result and before complete checkpoint.']);report.checkpointInterruption.recoveredResultSignature=executor.result(job.tenant,job.id,job.intents[0].id)!.resultSignature;if(interruptSigning||interruptBody){assert.equal(report.checkpointInterruption.originalResultSignature,undefined);assert.equal(resultSignerCalls,2);report.checkpointInterruption.missingResultSignedOnce=true;}else assert.equal(report.checkpointInterruption.recoveredResultSignature,report.checkpointInterruption.originalResultSignature);report.checkpointInterruption.automaticStartupRecoveryWithoutReplay=true;}
 if(interruptBody){assert.equal(cacheHits,1);assert.equal(journal.load(job.tenant,job.id,job.intents[0].id)!.responseRecoveries,1);assert.equal(report.cacheRetrievals[0].content,executor.result(job.tenant,job.id,job.intents[0].id)!.content);report.cachedResponseRecoveredWithoutPayment=true;}
 assert.equal(job.state,'completed');assert.equal(sends,12);assert.equal(models,2);assert.equal(executions,2);assert.equal(sponsorSigns,2);assert.equal(defaultRejects,0);
 assert.equal((await h.rpc('getTokenAccountBalance',[await sdk.deriveUsdcTokenAddress(session.address)])).value.amount,'0');assert.equal((await h.rpc('getTokenAccountBalance',[await sdk.deriveUsdcTokenAddress(agent.agent)])).value.amount,'0');assert.equal((await h.rpc('getTokenAccountBalance',[await sdk.deriveUsdcTokenAddress(recipient)])).value.amount,'2000');
 const outputs=job.intents.map((intent:any)=>executor.result(job.tenant,job.id,intent.id));assert.equal(outputs[0].sponsoredPayment.memo,'merchant-public-invoice');assert.match(outputs[1].sponsoredPayment.memo,/^[a-f0-9]{32}$/);
 for(const [index,output] of outputs.entries()){const tx=await h.rpc('getTransaction',[output.paymentSignature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);const sponsor=facilitators[index].wallet.address;assert.equal(before.get(sponsor)!-await h.sol(sponsor),BigInt(tx.meta.fee));assert.equal(tx.meta.fee,10000);assert.equal(getTransactionDecoder().decode(Buffer.from(output.sponsoredPayment.wire,'base64')).signatures[sponsor],null);}
 await writeFile(join(directory,'gateway-outputs.json'),JSON.stringify(outputs,null,2)+'\n');await writeFile(join(directory,'completed-job.json'),JSON.stringify(job,null,2)+'\n');
 report.identity={feePayer:payer.address,sessionKey:session.address,provider:recipient,tools};report.programBuild=JSON.parse(await readFile('target/sbf-safe/build-manifest.json','utf8'));report.sdkResponses=settlements;
 // Reopen the durable gateway journal and restart Runtime: original completed
 // outputs must survive without signing, paid HTTP replay, or model billing.
 journal.close();journal=new HeadlessJournal(journalPath);observeJournal(journal);options.journal=journal;executor=new HeadlessSkillExecutor(options);
 for(const intent of job.intents)assert.deepEqual(executor.result(job.tenant,job.id,intent.id),outputs.find(output=>output.intentId===intent.id));
 if(remoteCoordinator){await stop(activeWorker);await stop(centralChild);centralChild=await startCentral();report.centralCompletedRestartPid=centralChild.pid;activeWorker=await startPeer();}else await h.restartRuntime();await call('jobs/'+job.id+'/resume',{});assert.equal((await call('jobs/'+job.id)).job.state,'completed');assert.equal(executions,2);assert.equal(sends,12);assert.equal(sponsorSigns,2);assert.equal(models,2);assert.equal(await readFile(quotaPath,'utf8'),quotaBefore);
 for(const output of outputs)for(const signature of [output.fundingSignature,output.paymentSignature,output.resultSignature]){await finalized(signature);const tx=await h.rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);assert.ok(tx);const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,signature+'.json'),raw);report.transactions.push({signature,sha256:hex(digest(raw)),slot:tx.slot,fee:tx.meta.fee});}
 if(remoteCoordinator){
  await assert.rejects(()=>access(workerDatabase));await assert.rejects(()=>access(peerDatabase));
  assert.deepEqual(job.spent,{sol:'0',usdc:'2000'});assert.equal(job.intents.length,2);assert.equal(job.intents[0].phase,'complete');assert.equal(job.intents[1].phase,'complete');
  report.remoteTaskStorage=true;report.workerDatabaseFilesAbsent=true;report.remainingOriginalPlanCompleted=true;report.centralProcessRestarted=true;report.coordinationCommands=coordinationCommands;report.centralLeaseRecovered=true;report.cumulativeUsdc='2000';
 }
 Object.assign(report,{status:'passed',totalTransactions:sends,modelFixtureRequests:models,paidHttpCalls:executions,officialSdkVerified:true,defaultVerifierAccepted:true,sponsorOnlyPaidNetworkFee:true,realModelQuotaUnchanged:true,restartWithoutReplay:true,closedBrowserIndependent:true});
}catch(cause){report.status='failed';report.error=cause instanceof Error?cause.message:'Failed';process.exitCode=1;
}finally{
 Object.assign(report,{totalTransactions:sends,modelFixtureRequests:models,paidHttpCalls:executions,sponsorSigningRequests:sponsorSigns,cacheHits,resultSignerCalls,persistedBeforeSignedSimulation:interruptSigning});for(const signature of sentSignatures){if(report.transactions.some((row:any)=>row.signature===signature))continue;try{await finalized(signature);const tx=await h.rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);if(tx){const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,signature+'.json'),raw);report.transactions.push({signature,sha256:hex(digest(raw)),slot:tx.slot,fee:tx.meta.fee});}}catch{}}
 await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}journal?.close();if(h.root)await h.finish(report.status==='passed'?undefined:'Official x402 acceptance failed');console.log(JSON.stringify({status:report.status,evidence:directory}));
}

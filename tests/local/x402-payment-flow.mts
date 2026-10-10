import assert from 'node:assert/strict';
import { createServer,type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { getTransactionDecoder,getBase64EncodedWireTransaction,getBase58Decoder,type SignatureBytes } from '@solana/kit';
import { ExactSvmScheme } from '@x402/svm/exact/facilitator';
import type { FacilitatorSvmSigner } from '@x402/svm';
import { encodePaymentRequiredHeader,decodePaymentSignatureHeader,encodePaymentResponseHeader } from '@x402/core/http';
import { LocalHarness,digest,hex } from './harness.mts';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
import { HeadlessJournal } from '../../apps/runtime/src/headless-journal.ts';
import { HeadlessSkillExecutor } from '../../apps/runtime/src/headless-executor.ts';
import { parseStandardTools } from '../../apps/runtime/src/standard-tools.ts';
if(process.argv.length!==3||process.argv[2]!=='--run')throw new Error('Use --run for isolated official-SDK x402 acceptance.');
const h=new LocalHarness(),servers:Server[]=[],directory=resolve('docs/evidence/standard-x402-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(directory);const report:any={status:'running',network:'isolated-localnet',model:'local-protocol-fixture',sdk:'@x402/svm 2.28.0',limitations:['Facilitators must enable smart-wallet verification and explicitly allow the AgentOS program.','SDK fee-payer isolation requires a sponsor address distinct from the recipient owner.','Fixed classic USDC mint only; does not prove real-model quality or public-network deployment.'],transactions:[]};
let journal:HeadlessJournal|undefined,sends=0,models=0,executions=0,sponsorSigns=0,defaultRejects=0;const sentSignatures=new Set<string>();
const quotaPath=resolve('docs/evidence/deepseek-goal-20261009-quota.json'),quotaBefore=await readFile(quotaPath,'utf8');
async function body(req:AsyncIterable<unknown>){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));return JSON.parse(Buffer.concat(chunks).toString());}
async function listen(server:Server){servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const listener=server.address();assert.ok(listener&&typeof listener!=='string');return listener.port;}
async function finalized(signature:string){for(let n=0;n<300;n++){const status=(await h.rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}])).value[0];assert.equal(status?.err??null,null);if(status?.confirmationStatus==='finalized')return status.slot;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Original transaction not finalized.');}
try{
 await h.start();h.approved=true;const original=h.rpc.bind(h);h.rpc=async(method,params=[])=>{if(method==='sendTransaction')assert.ok(++sends<=10);const result=await original(method,params);if(method==='sendTransaction')sentSignatures.add(result);return result;};
 for(let n=0;n<150;n++){if(await h.rpc('getSlot',[{commitment:'confirmed'}])>=32)break;await new Promise(resolve=>setTimeout(resolve,200));}
 const {payer,session,provider,workerSession,workerOwner}=h.signers,recipient=workerOwner.address;
 const init=await sdk.buildInitializeAgent(payer.address,'Official x402 SDK acceptance',0.001,0.001,0.002,0.002,['api','payment']),agent=init.accounts;
 const delegated=await sdk.buildCreateSession(payer.address,agent.agent,agent.policy,session.address,BigInt(Math.floor(Date.now()/1000)+1800),0.001,0.001,0.002,0.002,['api','payment']);
 await h.tx('initialize x402 Agent',[init.instruction]);await h.tx('fund USDC Vault',[await sdk.buildDepositUsdc(payer.address,agent.agent,'0.002')]);await h.tx('create x402 Session',[delegated.instruction]);
 await h.tx('fund client rent reserve',[sdk.buildFundSessionFeeReserve(payer.address,session.address,0.02)]);
 await h.tx('fund merchant fee wallet',[sdk.buildFundSessionFeeReserve(payer.address,provider.address,0.01)]);await h.tx('fund independent sponsor',[sdk.buildFundSessionFeeReserve(payer.address,workerSession.address,0.01)]);
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
 const facilitators=[provider,workerSession].map(wallet=>({wallet,plain:new ExactSvmScheme(signer(wallet)),supported:new ExactSvmScheme(signer(wallet),undefined,{enableSmartWalletVerification:true,smartWalletAllowedPrograms:[sdk.PROGRAM_ADDRESS],maxRequiredSignatures:2})}));
 let servicePort=0;
 servicePort=await listen(createServer(async(req,res)=>{try{
  const index=req.url==='/merchant'?0:1,facilitator=facilitators[index],request=await body(req),endpoint=`http://127.0.0.1:${servicePort}${req.url}`;
  const accepted={scheme:'exact',network,amount:'1000',asset:sdk.DEVNET_USDC_MINT,payTo:recipient,maxTimeoutSeconds:60,extra:{...facilitator.supported.getExtra(network),...(index===0?{memo:'merchant-public-invoice'}:{})}};
  const required={x402Version:2,resource:{url:endpoint},accepts:[accepted]};
  if(!req.headers['payment-signature']){res.writeHead(402,{'payment-required':encodePaymentRequiredHeader(required)}).end();return;}
  const payload=decodePaymentSignatureHeader(String(req.headers['payment-signature']));assert.deepEqual(payload.accepted,accepted);assert.deepEqual(payload.resource,required.resource);
  const negative=await facilitator.plain.verify(payload,accepted);(report.sdkChecks??=[]).push({path:req.url,default:negative});assert.equal(negative.isValid,false);assert.equal(sponsorSigns,index);defaultRejects++;
  const verified=await facilitator.supported.verify(payload,accepted);report.sdkChecks.at(-1).supported=verified;assert.equal(verified.isValid,true,JSON.stringify(verified));
  const settled=await facilitator.supported.settle(payload,accepted);report.sdkChecks.at(-1).settled=settled;assert.equal(settled.success,true,JSON.stringify(settled));assert.ok(settled.transaction);executions++;settlements.push({sponsor:facilitator.wallet.address,verify:verified,settle:settled,defaultRejection:negative});
  res.setHeader('payment-response',encodePaymentResponseHeader(settled));res.end(JSON.stringify({publicAnswer:request.question,source:'official-x402-sdk',sponsor:index===0?'merchant':'independent'}));
 }catch(cause){const error=cause instanceof Error?cause.message:'Failed';(report.serviceErrors??=[]).push(error);res.writeHead(422).end(JSON.stringify({error}));}}));
 const tools=parseStandardTools(JSON.stringify(['merchant','independent'].map((name,index)=>({id:'http:x402-'+name,protocol:'x402',endpoint:`http://127.0.0.1:${servicePort}/`+(index===0?'merchant':'independent'),recipient,asset:'USDC',amount:'1000',description:'POST JSON object with public question'}))));
 const deviceToken='x402-owner-device-acceptance-test-20261010',gatewayToken='x402-gateway-acceptance-test-20261010',profile={tenant:'owner',tokenSha256:hex(digest(deviceToken)),agent:agent.agent,session:delegated.session,maxDurationSeconds:600,limits:{sol:'0',usdc:'2000',maxCycles:2,maxActions:2,maxModelRequests:4,tools:tools.map(tool=>tool.id)}};
 const journalPath=join(h.root,'x402-gateway.sqlite');journal=new HeadlessJournal(journalPath);
 const options={program:sdk.PROGRAM_ADDRESS,genesis:h.genesis,rpc:h.rpc.bind(h),feePayer:payer,signers:new Map([['owner',session]]),tenants:[profile],tools:new Map(),standardTools:new Map(tools.map(tool=>[tool.id,tool])),journal};
 let executor=new HeadlessSkillExecutor(options);
 const gatewayPort=await listen(createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer '+gatewayToken);if(req.method==='POST'){const input=await body(req);res.end(JSON.stringify(await executor.execute(input.job,input.action,input.intentId)));return;}
  const parts=req.url!.split('/'),result=executor.result(parts[2],parts[3],parts[4]);if(result)res.end(JSON.stringify(result));else res.writeHead(404).end();
 }catch(cause){const error=cause instanceof Error?cause.message:'Failed';(report.gatewayErrors??=[]).push(error);res.writeHead(422).end(JSON.stringify({error}));}}));
 const modelPort=await listen(createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer local-test-fixture');const input=await body(req);models++;const result=input.text.format.name==='agentos_autonomous_plan'?{actions:tools.map(tool=>({tool:tool.id,asset:tool.asset,input:JSON.stringify({question:'Public fixture question'})}))}:{complete:true,feedback:'Both standard outputs obtained',answer:'LOCAL FIXTURE: two x402 public responses.'};res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]}));}catch{res.writeHead(500).end();}}));
 Object.assign(process.env,{AGENTOS_LOCAL_MODEL_URL:`http://127.0.0.1:${modelPort}/v1/responses`,AGENTOS_AUTONOMOUS_TENANTS:JSON.stringify([profile]),AGENTOS_AUTONOMOUS_DATABASE_PATH:join(h.root,'x402-autonomous.sqlite'),AGENTOS_STANDARD_HTTP_TOOLS:JSON.stringify(tools),AGENTOS_EXECUTION_GATEWAY:`http://127.0.0.1:${gatewayPort}`,AGENTOS_EXECUTION_GATEWAY_TOKEN:gatewayToken,AGENTOS_EXECUTION_FEE_PAYER:payer.address});
 await h.runtime();const call=async(path:string,value?:unknown)=>{const response=await fetch(h.runtimeUrl+'/api/autonomous/'+path,{...(value?{method:'POST',body:JSON.stringify(value)}:{}),headers:{authorization:'Bearer '+deviceToken,'content-type':'application/json'}});const payload=await response.json();assert.ok(response.ok,JSON.stringify(payload));return payload as any;};
 const created=await call('jobs',{goal:'Obtain two public responses through standard x402 paid APIs.'});let job:any;
 for(let n=0;n<300;n++){const snapshot=await call('jobs/'+created.job.id);job=snapshot.job;if(job.state==='completed')break;if(snapshot.error||['failed','needs_reconciliation'].includes(job.state))throw new Error(JSON.stringify(snapshot));await new Promise(resolve=>setTimeout(resolve,500));}
 assert.equal(job.state,'completed');assert.equal(sends,10);assert.equal(models,2);assert.equal(executions,2);assert.equal(sponsorSigns,2);assert.equal(defaultRejects,2);
 assert.equal((await h.rpc('getTokenAccountBalance',[await sdk.deriveUsdcTokenAddress(agent.agent)])).value.amount,'0');assert.equal((await h.rpc('getTokenAccountBalance',[await sdk.deriveUsdcTokenAddress(recipient)])).value.amount,'2000');
 const outputs=job.intents.map((intent:any)=>executor.result(job.tenant,job.id,intent.id));assert.equal(outputs[0].sponsoredPayment.memo,'merchant-public-invoice');assert.match(outputs[1].sponsoredPayment.memo,/^[a-f0-9]{32}$/);
 for(const [index,output] of outputs.entries()){const tx=await h.rpc('getTransaction',[output.paymentSignature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);const sponsor=facilitators[index].wallet.address;assert.equal(before.get(sponsor)!-await h.sol(sponsor),BigInt(tx.meta.fee));assert.equal(tx.meta.fee,10000);assert.equal(getTransactionDecoder().decode(Buffer.from(output.sponsoredPayment.wire,'base64')).signatures[sponsor],null);}
 await writeFile(join(directory,'gateway-outputs.json'),JSON.stringify(outputs,null,2)+'\n');await writeFile(join(directory,'completed-job.json'),JSON.stringify(job,null,2)+'\n');
 report.identity={feePayer:payer.address,sessionKey:session.address,provider:recipient,tools};report.programBuild=JSON.parse(await readFile('target/sbf-safe/build-manifest.json','utf8'));report.sdkResponses=settlements;
 // Reopen the durable gateway journal and restart Runtime: original completed
 // outputs must survive without signing, paid HTTP replay, or model billing.
 journal.close();journal=new HeadlessJournal(journalPath);options.journal=journal;executor=new HeadlessSkillExecutor(options);
 for(const intent of job.intents)assert.deepEqual(executor.result(job.tenant,job.id,intent.id),outputs.find(output=>output.intentId===intent.id));
 await h.restartRuntime();await call('jobs/'+job.id+'/resume',{});assert.equal((await call('jobs/'+job.id)).job.state,'completed');assert.equal(executions,2);assert.equal(sends,10);assert.equal(sponsorSigns,2);assert.equal(models,2);assert.equal(await readFile(quotaPath,'utf8'),quotaBefore);
 for(const output of outputs)for(const signature of [output.paymentSignature,output.resultSignature]){await finalized(signature);const tx=await h.rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);assert.ok(tx);const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,signature+'.json'),raw);report.transactions.push({signature,sha256:hex(digest(raw)),slot:tx.slot,fee:tx.meta.fee});}
 Object.assign(report,{status:'passed',totalTransactions:sends,modelFixtureRequests:models,paidHttpCalls:executions,officialSdkVerified:true,defaultUnsupportedWalletRejected:true,sponsorOnlyPaidNetworkFee:true,realModelQuotaUnchanged:true,restartWithoutReplay:true,closedBrowserIndependent:true});
}catch(cause){report.status='failed';report.error=cause instanceof Error?cause.message:'Failed';process.exitCode=1;
}finally{
 Object.assign(report,{totalTransactions:sends,modelFixtureRequests:models,paidHttpCalls:executions,sponsorSigningRequests:sponsorSigns});for(const signature of sentSignatures){if(report.transactions.some((row:any)=>row.signature===signature))continue;try{await finalized(signature);const tx=await h.rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);if(tx){const raw=JSON.stringify({jsonrpc:'2.0',result:tx},(_key,value)=>typeof value==='bigint'?(JSON as any).rawJSON(value.toString()):value);await writeFile(join(directory,signature+'.json'),raw);report.transactions.push({signature,sha256:hex(digest(raw)),slot:tx.slot,fee:tx.meta.fee});}}catch{}}
 await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}journal?.close();if(h.root)await h.finish(report.status==='passed'?undefined:'Official x402 acceptance failed');console.log(JSON.stringify({status:report.status,evidence:directory}));
}

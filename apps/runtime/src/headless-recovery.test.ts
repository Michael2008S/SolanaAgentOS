import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseStandardTools } from './standard-tools.js';
import { parseAutonomousJob } from './autonomous-loop.js';
import { address,getAddressEncoder,getTransactionDecoder,getBase64EncodedWireTransaction,type SignatureBytes } from '@solana/kit';
import { HeadlessJournal,type HeadlessRecord } from './headless-journal.js';
import { HeadlessSkillExecutor } from './headless-executor.js';
const evidence=resolve('docs/evidence/standard-x402-prefunded-2026-10-09T19-58-47-332Z');
async function fixture(){
 const load=async(name:string)=>JSON.parse(await readFile(join(evidence,name),'utf8')),report=await load('report.json'),job=await load('completed-job.json'),output=(await load('gateway-outputs.json'))[0],transactions=new Map<string,any>();
 for(const signature of [output.fundingSignature,output.paymentSignature,output.resultSignature])transactions.set(signature,(await load(signature+'.json')).result);
 const root=await mkdtemp(join(tmpdir(),'agentos-readonly-recovery-')),file=join(root,'journal.sqlite');let journal=new HeadlessJournal(file),signs=0,sends=0,providerCalls=0,calls=0;
 const key=(value:string)=>({address:address(value),signTransactions:async()=>{signs++;throw new Error('Read-only recovery must not sign.');}});
 const state={missing:'' as string,network:job.genesis,failed:false,fee:10000,changed:false,reversed:false};
 const rpc=async(method:string,params:unknown[])=>{calls++;if(method==='getGenesisHash')return state.network;if(method==='sendTransaction'){sends++;throw new Error('Recovery must not broadcast.');}if(method!=='getTransaction')throw new Error('Unexpected recovery RPC '+method);assert.equal((params[1] as any).commitment,'finalized');const signature=String(params[0]);if(signature===state.missing)return null;const original=transactions.get(signature);assert.ok(original);return {...original,slot:state.reversed&&signature===output.resultSignature?0:original.slot,meta:{...original.meta,err:state.failed?'failed':null,fee:state.fee},transaction:state.changed?['different-wire','base64']:original.transaction};};
 const options={program:job.program,genesis:job.genesis,rpc,feePayer:key(report.identity.feePayer),signers:new Map([['owner',key(report.identity.sessionKey)]]),tenants:[{tenant:'owner',agent:job.agent,session:job.session,tokenSha256:'a'.repeat(64),maxDurationSeconds:600,limits:job.limits}],tools:new Map<string,string>(),journal,transport:async()=>{providerCalls++;throw new Error('Recovery must not call provider.');}};
 const record:HeadlessRecord={tenant:job.tenant,jobId:job.id,intentId:output.intentId,scopeHash:'a'.repeat(64),execution:output.execution,complete:false,funding:{signature:output.fundingSignature,wire:transactions.get(output.fundingSignature).transaction[0]},payment:{signature:output.paymentSignature,wire:transactions.get(output.paymentSignature).transaction[0]},result:{signature:output.resultSignature,wire:transactions.get(output.resultSignature).transaction[0]},content:output.content,paymentChallenge:output.paymentChallenge,sponsoredPayment:output.sponsoredPayment};
 const reopen=()=>{journal.close();journal=new HeadlessJournal(file);options.journal=journal;return new HeadlessSkillExecutor(options);};
 return {job,report,options,record,state,transactions,output,reopen,get journal(){return journal;},get effects(){return {signs,sends,providerCalls};},get calls(){return calls;},close:async()=>{journal.close();await rm(root,{recursive:true,force:true});}};
}
test('finalized original result survives process journal reopen and completes without signing, broadcast or provider replay',async()=>{
 const f=await fixture();try{
  f.journal.save(f.record);let executor=f.reopen();assert.equal(executor.result(f.record.tenant,f.record.jobId,f.record.intentId),null);
  assert.deepEqual(await executor.reconcileResult(f.record.tenant,f.record.jobId,f.record.intentId),f.output);assert.equal(f.journal.load(f.record.tenant,f.record.jobId,f.record.intentId)?.complete,true);
  executor=f.reopen();const before=f.calls;assert.deepEqual(await executor.reconcileResult(f.record.tenant,f.record.jobId,f.record.intentId),f.output);assert.equal(f.calls,before);assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});
 }finally{await f.close();}
});
test('missing finalized effects remain unresolved and invalid chain, fee, wire, result hash or ordering cannot complete',async()=>{
 const f=await fixture();try{
  f.journal.save(f.record);const executor=f.reopen(),recover=()=>executor.reconcileResult(f.record.tenant,f.record.jobId,f.record.intentId);
  for(const signature of [f.record.funding!.signature,f.record.payment!.signature,f.record.result!.signature]){f.state.missing=signature;assert.equal(await recover(),null);assert.equal(f.journal.load(f.record.tenant,f.record.jobId,f.record.intentId)?.complete,false);}f.state.missing='';
  for(const [field,value] of [['network',f.options.program],['failed',true],['fee',10001],['changed',true],['reversed',true]] as const){const old=f.state[field];Object.assign(f.state,{[field]:value});await assert.rejects(recover());Object.assign(f.state,{[field]:old});assert.equal(f.journal.load(f.record.tenant,f.record.jobId,f.record.intentId)?.complete,false);}
  assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});
 }finally{await f.close();}
 const changed=await fixture();try{changed.journal.save({...changed.record,content:'Altered response'});const executor=changed.reopen();await assert.rejects(executor.reconcileResult(changed.record.tenant,changed.record.jobId,changed.record.intentId),/instruction differs/);assert.deepEqual(changed.effects,{signs:0,sends:0,providerCalls:0});}finally{await changed.close();}
});
test('earlier incomplete stages do not trigger network or execution from result retrieval',async()=>{
 const f=await fixture();try{f.journal.save({...f.record,result:undefined});const executor=f.reopen();assert.equal(await executor.reconcileResult(f.record.tenant,f.record.jobId,f.record.intentId),null);assert.equal(f.calls,0);assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});}finally{await f.close();}
});

test('a corrupted saved client signature cannot become a completed result even if RPC echoes the same wire',async()=>{
 const f=await fixture();try{
  const original=f.transactions.get(f.record.payment!.signature),transaction=getTransactionDecoder().decode(Buffer.from(original.transaction[0],'base64')),client=Object.keys(transaction.signatures).find(key=>key!==Object.keys(transaction.signatures)[0])!;
  const wire=getBase64EncodedWireTransaction({...transaction,signatures:{...transaction.signatures,[client]:new Uint8Array(64) as SignatureBytes}});
  f.transactions.set(f.record.payment!.signature,{...original,transaction:[wire,'base64']});f.journal.save({...f.record,payment:{...f.record.payment!,wire}});
  const executor=f.reopen();await assert.rejects(executor.reconcileResult(f.record.tenant,f.record.jobId,f.record.intentId),/signature is invalid/);assert.equal(f.journal.load(f.record.tenant,f.record.jobId,f.record.intentId)?.complete,false);assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});
 }finally{await f.close();}
});

async function signedRecoveryFixture(withResult=true){
 const f=await fixture(),job=parseAutonomousJob({...f.job,state:'needs_reconciliation',limits:{...f.job.limits,deadline:Math.floor(Date.now()/1000)+600},intents:f.job.intents.map(({receipt,...intent}:any)=>({...intent,phase:'reserved'}))}),intent=job.intents.find(value=>value.id===f.record.intentId)!,action=intent.action,tool=parseStandardTools(JSON.stringify(f.report.identity.tools)).find(value=>value.id===action.tool)!;
 const base={job,action,intentId:intent.id,sessionKey:f.report.identity.sessionKey,feePayer:f.report.identity.feePayer,recipient:tool.recipient,endpoint:tool.endpoint},scopeHash=createHash('sha256').update(JSON.stringify({...base,job:{agent:job.agent,session:job.session,program:job.program,genesis:job.genesis,limits:job.limits},tool,executionId:intent.executionId})).digest('hex');
 f.journal.save({...f.record,scopeHash,...(!withResult?{result:undefined}:{})});let submitted=false,broadcasts=0;
 const state={simulationError:null as unknown,fee:10000,statusDisappears:false,statusReads:0,paymentMissing:false,revokedSession:!withResult};
 const rpc=async(method:string,params:unknown[])=>{
  if(method==='getTransaction'&&state.paymentMissing&&params[0]===f.record.payment!.signature)return null;
  if(method==='getTransaction'&&params[0]===f.record.result!.signature&&!submitted)return null;
  if(method==='getAccountInfo'&&params[0]===job.session&&state.revokedSession){const data=Buffer.alloc(147);createHash('sha256').update('account:Session').digest().subarray(0,8).copy(data);Buffer.from(getAddressEncoder().encode(address(job.agent))).copy(data,8);Buffer.from(getAddressEncoder().encode(address(f.report.identity.sessionKey))).copy(data,40);data[104]=5;data[105]=1;return {value:{owner:job.program,data:[data.toString('base64'),'base64']}};}
  if(method==='getSignatureStatuses')return {value:[state.statusDisappears?(++state.statusReads===1?{err:null,confirmationStatus:'confirmed'}:null):submitted?{err:null,confirmationStatus:'finalized'}:null]};
  if(method==='simulateTransaction'){assert.equal(params[0],f.record.result!.wire);assert.equal((params[1] as any).sigVerify,true);return {value:{err:state.simulationError}};}
  if(method==='getFeeForMessage')return {value:state.fee};
  if(method==='sendTransaction'){assert.equal(params[0],f.record.result!.wire);broadcasts++;submitted=true;return f.record.result!.signature;}
  return f.options.rpc(method,params);
 };
 const previous={cluster:process.env.AGENTOS_CLUSTER,genesis:process.env.AGENTOS_LOCALNET_GENESIS_HASH};process.env.AGENTOS_CLUSTER='localnet';process.env.AGENTOS_LOCALNET_GENESIS_HASH=job.genesis;
 const close=async()=>{if(previous.cluster===undefined)delete process.env.AGENTOS_CLUSTER;else process.env.AGENTOS_CLUSTER=previous.cluster;if(previous.genesis===undefined)delete process.env.AGENTOS_LOCALNET_GENESIS_HASH;else process.env.AGENTOS_LOCALNET_GENESIS_HASH=previous.genesis;await f.close();};
 const options={...f.options,tenants:f.options.tenants.map(profile=>({...profile,allowSessionTokenCustody:true})),rpc,standardTools:new Map([[tool.id,tool]])},executor=new HeadlessSkillExecutor(options);
 return {...f,options,close,executor,job,action,state,get effects(){return f.effects;},get broadcasts(){return broadcasts;}};
}
test('explicit recovery broadcasts only the saved result wire after simulation, with no signing or repeat payment',async()=>{
 const f=await signedRecoveryFixture();try{
  assert.equal(await f.executor.reconcileResult(f.job.tenant,f.job.id,f.record.intentId),null);assert.equal(f.broadcasts,0);
  const outputs=await Promise.all([f.executor.recoverResult(f.job,f.action,f.record.intentId),f.executor.recoverResult(f.job,f.action,f.record.intentId)]);assert.deepEqual(outputs,[f.output,f.output]);assert.equal(f.broadcasts,1);assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});
  assert.deepEqual(await f.executor.recoverResult(f.job,f.action,f.record.intentId),f.output);assert.equal(f.broadcasts,1);
 }finally{await f.close();}
});
test('signed-result recovery rejects modified job scope, stopped jobs, failed simulation and excessive fees without broadcasting',async()=>{
 const f=await signedRecoveryFixture();try{
  await assert.rejects(f.executor.recoverResult({...f.job,limits:{...f.job.limits,maxCycles:3}},f.action,f.record.intentId),/cannot change/);
  await assert.rejects(f.executor.recoverResult({...f.job,state:'cancelled'},f.action,f.record.intentId),/stopped or expired/);
  f.state.simulationError='BlockhashNotFound';await assert.rejects(f.executor.recoverResult(f.job,f.action,f.record.intentId),/no longer simulates/);f.state.simulationError=null;
  f.state.fee=10001;await assert.rejects(f.executor.recoverResult(f.job,f.action,f.record.intentId),/fee cap/);assert.equal(f.broadcasts,0);assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});
 }finally{await f.close();}
});

test('a previously observed result cannot be broadcast if its status disappears without a fresh simulation',async()=>{
 const f=await signedRecoveryFixture();try{f.state.statusDisappears=true;await assert.rejects(f.executor.recoverResult(f.job,f.action,f.record.intentId),/without simulation/);assert.equal(f.broadcasts,0);assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});}finally{await f.close();}
});

test('a saved paid response without result signatures still requires a live delegation and finalized payment',async()=>{
 const f=await signedRecoveryFixture(false);try{
  assert.equal(await f.executor.reconcileResult(f.job.tenant,f.job.id,f.record.intentId),null);
  await assert.rejects(f.executor.recoverResult({...f.job,state:'cancelled'},f.action,f.record.intentId),/cannot sign/);
  f.state.paymentMissing=true;await assert.rejects(f.executor.recoverResult(f.job,f.action,f.record.intentId),/finalized/);f.state.paymentMissing=false;
  f.options.tenants[0].allowSessionTokenCustody=false;await assert.rejects(f.executor.recoverResult(f.job,f.action,f.record.intentId),/has not enabled/);f.options.tenants[0].allowSessionTokenCustody=true;
  await assert.rejects(f.executor.recoverResult(f.job,f.action,f.record.intentId),/Session is inactive/);
  assert.equal(f.journal.load(f.job.tenant,f.job.id,f.record.intentId)?.result,undefined);assert.equal(f.broadcasts,0);assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});
 }finally{await f.close();}
});

test('missing response recovery is disabled by default and exhausted attempts never contact a provider',async()=>{
 const f=await fixture();try{
  const job=parseAutonomousJob({...f.job,state:'needs_reconciliation',limits:{...f.job.limits,deadline:Math.floor(Date.now()/1000)+600},intents:f.job.intents.map(({receipt,...intent}:any)=>({...intent,phase:'reserved'}))}),intent=job.intents.find(value=>value.id===f.record.intentId)!,tool=parseStandardTools(JSON.stringify(f.report.identity.tools)).find(value=>value.id===intent.action.tool)!;
  const record={...f.record,content:undefined,result:undefined};f.journal.save(record);
  const options={...f.options,standardTools:new Map([[tool.id,tool]])};let executor=new HeadlessSkillExecutor(options);
  assert.equal(await executor.recoverResult(job,intent.action,intent.id),null);assert.equal(f.calls,0);
  for(let responseRecoveries=1;responseRecoveries<=3;responseRecoveries++)f.journal.save({...record,responseRecoveries});
  options.standardTools.set(tool.id,{...tool,recoverResponse:true});executor=new HeadlessSkillExecutor(options);
  assert.equal(await executor.recoverResult(job,intent.action,intent.id),null);assert.equal(f.calls,0);assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});
 }finally{await f.close();}
});

test('legacy Skill cache recovery is opt-in and durable exhaustion stops before any RPC or Provider call',async()=>{
 const f=await fixture();try{
  const intent=f.job.intents.find((value:any)=>value.id===f.record.intentId),skill=f.job.agent;
  const action={...intent.action,tool:skill},job=parseAutonomousJob({...f.job,state:'needs_reconciliation',limits:{...f.job.limits,tools:[skill]},intents:f.job.intents.map((value:any)=>value.id===intent.id?{...value,action,phase:'reserved',receipt:undefined}:value)});
  const options={...f.options,tools:new Map([[skill,'http://127.0.0.1:19791/fixture']])};
  f.journal.save({...f.record,content:undefined,result:undefined});
  assert.equal(await new HeadlessSkillExecutor(options).recoverResult(job,action,intent.id),null);
  for(let responseRecoveries=1;responseRecoveries<=3;responseRecoveries++)f.journal.save({...f.record,content:undefined,result:undefined,responseRecoveries});
  f.reopen();options.journal=f.journal;
  assert.equal(await new HeadlessSkillExecutor({...options,recoverSkillResponses:new Set([skill])}).recoverResult(job,action,intent.id),null);
  assert.throws(()=>new HeadlessSkillExecutor({...options,recoverSkillResponses:new Set(['unregistered'])}),/fixed registered tools/);
  assert.equal(f.calls,0);assert.deepEqual(f.effects,{signs:0,sends:0,providerCalls:0});
 }finally{await f.close();}
});

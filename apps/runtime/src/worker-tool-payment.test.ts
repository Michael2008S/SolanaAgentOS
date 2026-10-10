import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getTransactionDecoder,getCompiledTransactionMessageDecoder } from '@solana/kit';
import { workerToolPaymentProfiles,workerToolPaymentInput,workerTaskSkillScope,workerToolId } from './worker-tool-payment.js';
import { HeadlessWorkerTool } from './headless-worker-tool.js';
const directories=['background-worker-tools-sol-2026-10-10T01-00-20-695Z','background-worker-tools-usdc-2026-10-10T01-18-05-454Z'];
for(const directory of directories)test('Task Skill scope matches authoritative native '+directory,async()=>{
 const root=join('docs/evidence',directory),report=JSON.parse(await readFile(join(root,'report.json'),'utf8'));
 const scope=await workerTaskSkillScope({program:report.programId??'HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv',agent:report.worker,session:report.workerSession,sessionKey:report.sessionSigner,feePayer:report.feePayer,provider:report.provider,taskId:'0',actionId:'0',executionId:'0',request:report.request,amount:report.request.maxAmount});
 assert.equal(scope.execution,report.toolExecution);if(report.task)assert.equal(scope.task,report.task);if(report.taskAction)assert.equal(scope.taskAction,report.taskAction);
 // Older SOL evidence contains only an online report; compare USDC native wires below.
 if(report.asset==='USDC')for(const [file,accounts,data] of [['payment-transaction.json',scope.accounts,scope.paymentData],['result-transaction.json',scope.resultAccounts,scope.resultData(report.content)]] as const){const rpc=JSON.parse(await readFile(join(root,file),'utf8')),message=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(rpc.transaction[0],'base64')).messageBytes);assert.notEqual(message.version,1);if(message.version===1)throw new Error('Unsupported fixture');const ix=message.instructions[0];assert.deepEqual(ix.accountIndices?.map(i=>String(message.staticAccounts[i])),accounts);assert.deepEqual(Buffer.from(ix.data??[]),data);const expectedRoles=file.startsWith('payment')?scope.roles:scope.resultRoles;assert.deepEqual(ix.accountIndices?.map(i=>i<message.header.numSignerAccounts?(i<message.header.numSignerAccounts-message.header.numReadonlySignerAccounts?3:2):(i<message.staticAccounts.length-message.header.numReadonlyNonSignerAccounts?1:0)),expectedRoles);}
});
test('fixed scopes reject duplicates, invalid counters and changed requests before chain or tool contact',async()=>{
 const r=JSON.parse(await readFile(join('docs/evidence',directories[1],'report.json'),'utf8')),profile={tenant:'worker',escrow:r.escrow,taskHash:'a'.repeat(64),taskId:'0',tools:[{request:r.request,executionId:'0',actionId:'0'}]},input={tenant:'worker',escrow:r.escrow,taskHash:profile.taskHash,toolId:workerToolId(r.request),dispatchId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'};
 assert.throws(()=>workerToolPaymentProfiles.parse([profile,profile]));assert.throws(()=>workerToolPaymentProfiles.parse([{...profile,taskId:'18446744073709551616'}]));assert.throws(()=>workerToolPaymentInput.parse({...input,unexpected:true}));
 let calls=0;const signer={address:r.sessionSigner,signTransactions:async()=>{throw new Error('Must not sign');}};
 const options:any={program:'HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv',genesis:'test',rpc:async()=>{calls++;throw new Error('Must not contact chain');},feePayer:{address:r.feePayer},signers:new Map([['worker',signer]]),identities:[{tenant:'worker',agent:r.worker,session:r.workerSession}],profiles:[profile],journal:{}};
 const executor=new HeadlessWorkerTool(options);await assert.rejects(executor.execute({...input,toolId:'b'.repeat(64)}),/fixed tenant/);await assert.rejects(executor.preflight({...input,taskHash:'b'.repeat(64)}),/fixed tenant/);assert.equal(calls,0);
 assert.throws(()=>new HeadlessWorkerTool({...options,profiles:[{...profile,tools:[profile.tools[0],profile.tools[0]]}]}),/globally unique/);
 assert.throws(()=>new HeadlessWorkerTool({...options,profiles:[profile,{...profile,escrow:r.worker}]}),/globally unique/);
});
test('live Worker preflight rejects revoked scope, expired commitments and insufficient Task or Session budgets without signing or Provider calls',async()=>{
 const r=JSON.parse(await readFile(join('docs/evidence',directories[1],'report.json'),'utf8')),snapshots=JSON.parse(await readFile(join('docs/evidence',directories[1],'account-snapshots.json'),'utf8'));
 const {createHash}=await import('node:crypto'),{address,getAddressEncoder}=await import('@solana/kit'),encode=(key:string)=>Buffer.from(getAddressEncoder().encode(address(key))),digest=(text:string)=>createHash('sha256').update(text).digest();
 const task=Buffer.from(snapshots[r.task].value.data[0],'base64'),taskHash=task.subarray(80,112).toString('hex'),input={tenant:'worker',escrow:r.escrow,taskHash,toolId:workerToolId(r.request),dispatchId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'};
 const program=r.programId??'HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv';const scope=await workerTaskSkillScope({program,agent:r.worker,session:r.workerSession,sessionKey:r.sessionSigner,feePayer:r.feePayer,provider:r.provider,taskId:'0',actionId:'0',executionId:'0',request:r.request,amount:r.request.maxAmount});
 const data=new Map<string,Buffer>();for(const [key,value] of Object.entries(snapshots) as [string,any][])data.set(key,Buffer.from(value.value.data[0],'base64'));
 const now=BigInt(Math.floor(Date.now()/1000));data.get(r.worker)!.writeBigUInt64LE(0n,113);const s=data.get(r.workerSession)!;s.writeBigInt64LE(now+700n,72);s.writeBigUInt64LE(0n,139);
 task.writeBigUInt64LE(0n,136);task.writeBigUInt64LE(0n,170);task.writeBigInt64LE(now+500n,162);data.set(r.task,task);data.get(r.escrow)!.writeBigInt64LE(now+600n,88);
 const skill=Buffer.alloc(130);digest('account:Skill').subarray(0,8).copy(skill);encode(r.provider).copy(skill,8);digest('worker-tool').copy(skill,40);digest(r.request.endpoint).copy(skill,72);skill[112]=1;skill.writeBigUInt64LE(BigInt(r.request.maxAmount),114);data.set(r.request.skill,skill);
 const p=Buffer.alloc(123);digest('account:Policy').subarray(0,8).copy(p);encode(r.worker).copy(p,8);p[72]=4;p.writeBigUInt64LE(1000000n,91);p.writeBigUInt64LE(1000000n,99);data.set(scope.policy,p);
 let signs=0,providerCalls=0;const options:any={program,genesis:'fixed',rpc:async(method:string,params:any[])=>{if(method==='getGenesisHash')return 'fixed';assert.equal(method,'getAccountInfo');const bytes=data.get(params[0]);return {value:bytes?{owner:program,executable:false,data:[bytes.toString('base64'),'base64']}:null};},feePayer:{address:r.feePayer},signers:new Map([['worker',{address:r.sessionSigner,signTransactions:async()=>{signs++;throw new Error('Must not sign');}}]]),identities:[{tenant:'worker',agent:r.worker,session:r.workerSession}],profiles:[{tenant:'worker',escrow:r.escrow,taskHash,taskId:'0',tools:[{request:r.request,actionId:'0',executionId:'0'}]}],journal:{},transport:async()=>{providerCalls++;throw new Error('Must not contact provider');}};
 const executor=new HeadlessWorkerTool(options);assert.deepEqual(await executor.preflight(input),{execution:r.toolExecution,taskId:'0',actionId:'0'});
 const cases:[string,number,Buffer][]=[[r.workerSession,105,Buffer.from([1])],[r.workerSession,104,Buffer.from([2])],[r.workerSession,72,Buffer.alloc(8)],[r.workerSession,115,Buffer.from([0])],[r.workerSession,107,Buffer.from([1,0,0,0,0,0,0,0])],[r.task,144,Buffer.from([2])],[r.task,120,Buffer.alloc(8)],[r.workerSession,131,Buffer.alloc(8)],[r.escrow,129,Buffer.from([3])],[r.escrow,88,Buffer.alloc(8)],[r.worker,113,Buffer.from([1,0,0,0,0,0,0,0])],[r.request.skill,112,Buffer.from([0])]];
 for(const [key,offset,replacement] of cases){const original=Buffer.from(data.get(key)!);replacement.copy(data.get(key)!,offset);await assert.rejects(executor.preflight(input));data.set(key,original);}
 assert.equal(signs,0);assert.equal(providerCalls,0);
});

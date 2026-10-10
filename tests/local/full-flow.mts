import { startModelFixture } from './model-fixture.mts';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { address, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from '@x402/core/http';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
import { decodeTaskSnapshot } from '../../apps/runtime/src/task-state.ts';
import { LocalHarness, digest, hex } from './harness.mts';
const h=new LocalHarness(); let server: Server|undefined; let modelServer: Server|undefined;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
try {
 await h.start();const prepared=await h.prepareReview();await h.authorize();
 const {payer,workerOwner,judgeOwner,session,workerSession,judgeSession,provider}=h.signers;
 const deadline=BigInt(Math.floor(Date.now()/1000)+600);
 for(const role of [workerOwner,judgeOwner,provider])await h.tx('fund temporary test participant',[sdk.buildFundSessionFeeReserve(payer.address,role.address,0.3)]);
 await h.tx('initialize Employer',[prepared.instruction]);
 const employer=prepared.accounts;
 const workerInit=await sdk.buildInitializeAgent(workerOwner.address,'Local E2E Worker',5,1,100,20,['api','payment','escrow']);
 await h.tx('initialize Worker',[workerInit.instruction],[workerOwner]);const worker=workerInit.accounts;
 const judgeInit=await sdk.buildInitializeAgent(judgeOwner.address,'Local E2E Judge',5,1,100,20,['api','payment','escrow']);
 await h.tx('initialize Judge',[judgeInit.instruction],[judgeOwner]);const judge=judgeInit.accounts;
 await h.tx('deposit Employer SOL',[await sdk.buildDeposit(payer.address,employer.agent,employer.vault,0.5)]);
 await h.tx('deposit Worker SOL',[await sdk.buildDeposit(workerOwner.address,worker.agent,worker.vault,0.1)],[workerOwner]);
 await h.tx('deposit Employer local USDC',[await sdk.buildDepositUsdc(payer.address,employer.agent,'20')]);assert.equal(await h.usdc(employer.agent),20_000_000n);
 const badMintDeposit=await sdk.buildDepositUsdc(payer.address,employer.agent,'0.1');
 const badMintInstruction={...badMintDeposit,accounts:badMintDeposit.accounts!.map((account,index)=>index===2?{...account,address:h.wrongMint}:account)};
 const mintBefore={sol:await h.sol(payer.address),usdc:await h.usdc(employer.agent),policy:await h.data(employer.policy)};
 await h.tx('valid foreign Mint rejected by token Mint constraint',[badMintInstruction],[],'ConstraintTokenMint');
 assert.equal(await h.sol(payer.address),mintBefore.sol);assert.equal(await h.usdc(employer.agent),mintBefore.usdc);assert.deepEqual(await h.data(employer.policy),mintBefore.policy);
 h.pass('Wrong Mint simulation changes neither funds nor Policy');

 const es=await sdk.buildCreateSession(payer.address,employer.agent,employer.policy,session.address,deadline+30n,1,2,10,30,['api','payment','escrow']);await h.tx('create Employer Session',[es.instruction]);
 const ws=await sdk.buildCreateSession(workerOwner.address,worker.agent,worker.policy,workerSession.address,deadline+30n,1,2,10,30,['api','payment','escrow']);await h.tx('create Worker Session',[ws.instruction],[workerOwner]);
 const js=await sdk.buildCreateSession(judgeOwner.address,judge.agent,judge.policy,judgeSession.address,deadline+30n,1,2,10,30,['api','payment','escrow']);await h.tx('create Judge Session',[js.instruction],[judgeOwner]);
 let eid=0n,wid=0n,action=0n,escrowId=100n;
 const workerFunds=await sdk.buildExecuteUsdcPayment(payer.address,employer.agent,employer.policy,es.session,session,workerOwner.address,'3',digest('worker funding'),digest('funded'),eid++);await h.tx('fund Worker Owner USDC',[workerFunds.instruction]);await h.tx('deposit Worker USDC',[await sdk.buildDepositUsdc(workerOwner.address,worker.agent,'3')],[workerOwner]);assert.equal(await h.usdc(worker.agent),3_000_000n);
 const taskText='Summarize the local test facts and deliver the answer.';
 const taskId=1n;const task=await sdk.buildCreateTask(payer.address,employer.agent,es.session,taskId,digest(taskText),100_000_000n,10_000_000n,deadline);await h.tx('create independent Task',[task.instruction]);await h.tx('start Task',[(await sdk.buildSetTaskStatus(payer.address,employer.agent,taskId,'running')).instruction]);
 const taskView=()=>h.data(task.task).then(b=>decodeTaskSnapshot(task.task,b,sdk.PROGRAM_ADDRESS));
 const legacy=await sdk.buildExecutePayment(payer.address,employer.agent,employer.policy,employer.vault,es.session,session,provider.address,0.001,digest('bypass'),digest('bypass'),eid);
 await h.tx('task-bound Session cannot use legacy payment',[legacy.instruction],[],'InvalidTaskSession');
 const over=await sdk.buildTaskPayment({feePayer:payer.address,agent:employer.agent,session:es.session,sessionSigner:session,taskId,executionId:eid,actionId:action,recipient:provider.address,asset:'SOL',amountAtomic:100_000_001n,inputHash:digest('over budget'),outputHash:digest('over budget')});await h.tx('Task rejects budget overflow',[over.instruction],[],'TaskBudgetExceeded');assert.equal((await taskView()).sol.spent,'0');
 const resource='http://127.0.0.1:19788/fixture';const registered=await sdk.buildRegisterSkill(provider.address,digest('local-fixture'),digest(resource),0.001,'0.1');await h.tx('register fixed-price Skill',[registered.instruction],[provider]);
 const {createAgentOsVaultSkillHandler,hashAgentOsSkillRequest}=await import('../../apps/runtime/src/x402-vault.ts');
 const {localClaimExecution}=await import('../../apps/runtime/src/local-provider.ts');const {localSkillResultStore}=await import('../../apps/runtime/src/skill-result-store.ts');
 let executions=0;
 const createHandler=()=>createAgentOsVaultSkillHandler({programId:sdk.PROGRAM_ADDRESS,skill:registered.skill,resourceUrl:resource,allowedOrigins:['http://127.0.0.1:15173'],rpcUrl:h.rpcUrl,claimExecution:localClaimExecution('e2e-fixture'),resultStore:localSkillResultStore('e2e-fixture',sdk.PROGRAM_ADDRESS),execute:async({prompt})=>{executions++;return `LOCAL TEST FIXTURE: ${prompt}; facts verified for protocol testing.`;}});
 let handler=createHandler();
 server=createServer(async(req,res)=>{try{const chunks=[];for await(const b of req)chunks.push(Buffer.from(b));const response=await handler(new Request(resource,{method:req.method,headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());}catch(e){res.writeHead(500).end(String(e));}});server.listen(19788,'127.0.0.1');await once(server,'listening');
 const fixture=await startModelFixture(0);modelServer=fixture.server;process.env.AGENTOS_LOCAL_MODEL_URL=fixture.url;
 await h.runtime();
 const health=await h.api("/api/health");assert.equal(health.modelBackend,"local-fixture");
 const plan=await h.api("/api/run",{task:taskText,agent:employer.agent,session:es.session,taskId:taskId.toString()});assert.equal(plan.planner.model,"local-test-fixture");assert.ok(plan.trace.some((row:any)=>row.skillId));h.pass("Runtime plans Task using live chain permissions and Skill directory");
 async function skillCall(asset:'SOL'|'USDC',who:typeof employer,sessionAddress:typeof es.session,signer:KeyPairSigner,taskScoped:boolean) {
  const prompt=`${asset} protocol facts`;const inputHash=await hashAgentOsSkillRequest(registered.skill,prompt);
  const body={protocol:'agentos-skill-v2',agent:who.agent,paymentPreference:asset,skill:{address:registered.skill},request:{skill:registered.skill,prompt,sha256:inputHash}};
  const request=async(headers:Record<string,string>={})=>fetch(resource,{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:15173',...headers},body:JSON.stringify(body)});
  const challenge=await request();assert.equal(challenge.status,402);const required=decodePaymentRequiredHeader(challenge.headers.get('PAYMENT-REQUIRED')!);assert.equal(required.accepts[0].network,`solana:${h.genesis.slice(0,32)}`);
  const id=taskScoped?eid++:wid++;const act=action++;
  const paid=taskScoped?await sdk.buildPayTaskSkill({feePayer:payer.address,agent:who.agent,session:sessionAddress,sessionSigner:signer,taskId,actionId:act,executionId:id,skill:registered.skill,provider:provider.address,asset,expectedPrice:asset==='SOL'?1_000_000n:100_000n,inputHash:Buffer.from(inputHash,'hex')}):asset==='SOL'?await sdk.buildPaySkill(payer.address,who.agent,who.policy,who.vault,sessionAddress,signer,registered.skill,provider.address,1_000_000n,Buffer.from(inputHash,'hex'),id):await sdk.buildPayUsdcSkill(payer.address,who.agent,who.policy,sessionAddress,signer,registered.skill,provider.address,100_000n,Buffer.from(inputHash,'hex'),id);
  const before=asset==='SOL'?await h.sol(provider.address):await h.usdc(provider.address).catch(()=>0n);
  const signature=await h.tx(`${asset} ${taskScoped?'Task':'Worker'} Skill payment`,[paid.instruction]);
  const after=asset==='SOL'?await h.sol(provider.address):await h.usdc(provider.address);assert.equal(after-before,asset==='SOL'?1_000_000n:100_000n);
  if(taskScoped){assert.equal((await taskView()).pendingSkillResults,'1');await h.tx('Task cannot complete before Skill result',[(await sdk.buildSetTaskStatus(payer.address,who.agent,taskId,'completed',digest('final'))).instruction],[],'TaskResultRequired');}
  const header=encodePaymentSignatureHeader({x402Version:2,resource:required.resource,accepted:required.accepts[0],payload:{agent:who.agent,skill:registered.skill,inputHash,execution:paid.execution,signature}});
  const response=await request({'PAYMENT-SIGNATURE':header});const content=await response.text();assert.equal(response.status,200,content);assert.ok(content.startsWith('LOCAL TEST FIXTURE:'));const count=executions;
  // Losing the first HTTP response does not require another payment or another tool execution.
  handler=createHandler();const recovered=await request({'PAYMENT-SIGNATURE':header,'AGENTOS-RESULT-ONLY':'true'});assert.equal(recovered.status,200);assert.equal(await recovered.text(),content);assert.equal(executions,count);
  const repeated=await request({'PAYMENT-SIGNATURE':header});assert.equal(repeated.status,200);assert.equal(await repeated.text(),content);assert.equal(executions,count);
  const record=taskScoped?await sdk.buildRecordTaskSkillResult({feePayer:payer.address,agent:who.agent,session:sessionAddress,sessionSigner:signer,taskId,actionId:act,execution:paid.execution,outputHash:digest(content)}):await sdk.buildRecordSkillResult(payer.address,who.agent,sessionAddress,signer,paid.execution,digest(content));
  await h.tx(`${asset} Skill result commitment`,[record]);await h.tx('duplicate Skill result rejected',[record],[],'SkillResultAlreadyRecorded');
  if(taskScoped)assert.equal((await taskView()).pendingSkillResults,'0');
  await h.api('/api/memory',{agent:who.agent,execution:paid.execution,title:'Local fixture facts',content,tags:['local','fixture']});
  await h.api('/api/memory',{agent:who.agent,execution:paid.execution,title:'tampered',content:content+' changed',tags:[]},422);
  h.pass(`${asset} Skill 402/payment/result-only recovery/Memory`,{signature,execution:paid.execution,contentHash:hex(digest(content)),toolExecutions:executions});
  return {execution:paid.execution,content,hash:hex(digest(content))};
 }
 const solResult=await skillCall('SOL',employer,es.session,session,true);const usdcResult=await skillCall('USDC',employer,es.session,session,true);
 const answer=await h.api('/api/finalize',{task:taskText,responses:[{skillId:registered.skill,content:solResult.content,truncated:false},{skillId:registered.skill,content:usdcResult.content,truncated:false}]});assert.ok(answer.answer.includes('LOCAL TEST FIXTURE'));h.pass('Runtime synthesizes final answer from paid Skill results');
 const source=await skillCall('SOL',worker,ws.session,workerSession,false);
 const sources=[{execution:source.execution,contentHash:source.hash}];
 const escrowAmount=(asset:'SOL'|'USDC')=>asset==='SOL'?10_000_000n:1_000_000n;
 const repBefore=await h.data(worker.reputation);const countBefore=repBefore.readBigUInt64LE(40);
 async function makeEscrow(asset:'SOL'|'USDC',note:string,closesAt=deadline,selectedWorker=worker.agent) {
  const text=`${taskText} ${note}`;
  const escrow=await sdk.buildCreateTaskEscrow({feePayer:payer.address,agent:employer.agent,session:es.session,sessionSigner:session,taskId,actionId:action++,escrowId:escrowId++,executionId:eid++,workerAgent:selectedWorker,asset,amountAtomic:escrowAmount(asset),deadline:closesAt,taskHash:digest(text)});
  await h.tx(`fund ${asset} Task Escrow ${note}`,[escrow.instruction]);assert.equal((await taskView()).pendingEscrows,'1');
  await h.tx('Task cannot complete with open Escrow',[(await sdk.buildSetTaskStatus(payer.address,employer.agent,taskId,'completed',digest('final'))).instruction],[],'TaskResultRequired');
  await h.api('/api/escrow/task',{escrow:escrow.escrow,task:text});
  return {...escrow,text};
 }
 async function deliver(escrow:Awaited<ReturnType<typeof makeEscrow>>) {
  await h.tx('grant scoped Worker delivery',[await sdk.buildGrantWorkerDelivery(workerOwner.address,worker.agent,ws.session,escrow.escrow,deadline)],[workerOwner]);
  let ready:any;
  for(let n=0;n<60;n++){ready=(await h.api(`/api/worker/jobs?worker=${worker.agent}`)).jobs.find((j:any)=>j.escrow===escrow.escrow);if(ready?.state==='ready')break;if(ready?.state==='failed')throw new Error(ready.error);await pause(100);}
  assert.equal(ready.state,'ready');assert.equal(ready.model,'local-test-fixture');const result=ready.result;assert.equal(hex(digest(result)),ready.resultHash);
  h.pass('Worker persistent queue produces committed draft',{escrow:escrow.escrow});
  const instruction=await sdk.buildSubmitSessionEscrowResult({feePayer:payer.address,workerAgent:worker.agent,session:ws.session,sessionSigner:workerSession,escrow:escrow.escrow,resultHash:digest(result),sources});
  await h.tx('Worker Session delivers with Skill source',[instruction]);
  await h.tx('Worker delivery is one-shot',[await sdk.buildSubmitSessionEscrowResult({feePayer:payer.address,workerAgent:worker.agent,session:ws.session,sessionSigner:workerSession,escrow:escrow.escrow,resultHash:digest('second result'),sources:[]})],[],'EscrowResultAlreadySubmitted');
  await h.api('/api/escrow/handoff',{escrow:escrow.escrow,task:escrow.text,result});
  return result;
 }
 for(const asset of ['SOL','USDC'] as const) {
  for(const verdict of ['pass','fail','needs_review'] as const) {
   const escrow=await makeEscrow(asset,`${verdict} case`);
   const job=await h.api('/api/worker/jobs',{escrow:escrow.escrow,workerAgent:worker.agent,task:escrow.text,evidence:'',sourceExecutions:[source.execution],toolRequests:[]});assert.equal(job.network,'localnet-preview');
   await h.tx('Employer proposes independent Judge',[await sdk.buildProposeEscrowJudge(payer.address,employer.agent,worker.agent,escrow.escrow,judge.agent,js.session,deadline)]);
   await h.tx('Worker accepts exact Judge terms',[await sdk.buildAcceptEscrowJudge(workerOwner.address,worker.agent,escrow.escrow,{judgeAgent:judge.agent,session:js.session,expiresAt:deadline,taskHash:digest(escrow.text)})],[workerOwner]);
   const result=await deliver(escrow);
   const advisory=await h.api('/api/escrow/judge',{task:escrow.text,result,taskHash:hex(digest(escrow.text)),resultHash:hex(digest(result))});assert.equal(advisory.verdict,verdict);assert.equal(advisory.model,'local-test-fixture');
   const assessment=await sdk.buildRecordEscrowJudgment({feePayer:payer.address,judge:judge.agent,session:js.session,signer:judgeSession,escrow:escrow.escrow,verdict,taskHash:digest(escrow.text),resultHash:digest(result),judgmentHash:Buffer.from(advisory.judgmentHash,'hex')});
   await h.tx(`Judge records ${verdict}`,[assessment]);
   const settle=await sdk.buildSettleJudgedEscrow({caller:payer.address,employer:employer.agent,worker:worker.agent,escrow:escrow.escrow,asset,execution:escrow.execution,task:task.task});
   const getEmployer=()=>asset==='SOL'?h.sol(employer.vault):h.usdc(employer.agent);const getWorker=()=>asset==='SOL'?h.sol(worker.vault):h.usdc(worker.agent);
   const beforeEmployer=await getEmployer(),beforeWorker=await getWorker();
   if(verdict==='needs_review') {
    await h.tx('needs_review cannot move funds',[settle],[],'JudgeNeedsReview');assert.equal(await getEmployer(),beforeEmployer);assert.equal(await getWorker(),beforeWorker);
    await h.tx('manual review resolves by Owner release',[(asset==='SOL'?await sdk.buildReleaseEscrow(payer.address,employer.agent,es.session,session,escrow.escrow,worker.agent,eid-1n,task.task):await sdk.buildReleaseUsdcEscrow(payer.address,employer.agent,es.session,session,escrow.escrow,worker.agent,eid-1n,task.task)).instruction]);
   } else await h.tx(`${asset} Judge ${verdict} settlement`,[settle]);
   const amount=escrowAmount(asset);
   if(verdict==='fail')assert.equal(await getEmployer()-beforeEmployer,amount);else assert.equal(await getWorker()-beforeWorker,amount);
   assert.equal((await taskView()).pendingEscrows,'0');
   const decision=await h.data(await sdk.deriveJudgeDecisionAddress(escrow.escrow));assert.equal(decision[241],verdict==='needs_review'?0:1);
   h.pass(`${asset} Worker/Judge ${verdict} exact settlement`,{escrow:escrow.escrow,amount:amount.toString()});
   const settledSnapshot={employer:await getEmployer(),worker:await getWorker(),escrow:await h.data(escrow.escrow),decision:await h.data(await sdk.deriveJudgeDecisionAddress(escrow.escrow)),reputation:await h.data(worker.reputation),task:await h.data(task.task)};
   await h.tx(`${asset} Judge ${verdict} cannot settle twice`,[settle],[],'InvalidEscrowState');
   assert.equal(await getEmployer(),settledSnapshot.employer);assert.equal(await getWorker(),settledSnapshot.worker);
   assert.deepEqual(await h.data(escrow.escrow),settledSnapshot.escrow);assert.deepEqual(await h.data(await sdk.deriveJudgeDecisionAddress(escrow.escrow)),settledSnapshot.decision);
   assert.deepEqual(await h.data(worker.reputation),settledSnapshot.reputation);assert.deepEqual(await h.data(task.task),settledSnapshot.task);
   h.pass(`${asset} Judge ${verdict} repeat settlement leaves balances and accounting unchanged`);

  }
 }
 for(const asset of ['SOL','USDC'] as const) {
  const cancelled=await makeEscrow(asset,'cancel case');
  const before=asset==='SOL'?await h.sol(employer.vault):await h.usdc(employer.agent);
  const ix=asset==='SOL'?await sdk.buildCancelEscrow(workerOwner.address,employer.agent,worker.agent,cancelled.escrow,eid-1n,task.task):await sdk.buildCancelUsdcEscrow(workerOwner.address,employer.agent,worker.agent,cancelled.escrow,eid-1n,task.task);
  await h.tx(`${asset} Worker cancellation refund`,[ix.instruction],[workerOwner]);assert.equal((asset==='SOL'?await h.sol(employer.vault):await h.usdc(employer.agent))-before,escrowAmount(asset));assert.equal((await taskView()).pendingEscrows,'0');h.pass(`${asset} cancellation preserves Task gross spending`);
 }
 for(const asset of ['SOL','USDC'] as const) {
  const split=await makeEscrow(asset,'cooperative split');const workerShare=escrowAmount(asset)/2n;
  const proposed=await sdk.buildProposeEscrowSettlement(payer.address,employer.agent,worker.agent,split.escrow,workerShare);await h.tx(`${asset} propose exact split`,[proposed.instruction]);
  const termsData=await h.data(proposed.settlement);const terms={proposer:payer.address,workerAmount:workerShare,deadline:termsData.readBigInt64LE(80)};
  const accept=asset==='SOL'?sdk.buildAcceptEscrowSettlement:sdk.buildAcceptUsdcEscrowSettlement;
  const changed=await accept(workerOwner.address,employer.agent,worker.agent,split.escrow,{...terms,workerAmount:workerShare+1n},eid-1n,task.task);
  await h.tx('changed settlement terms rejected',[changed.instruction],[workerOwner],'SettlementTermsChanged');
  const beforeEmployer=asset==='SOL'?await h.sol(employer.vault):await h.usdc(employer.agent),beforeWorker=asset==='SOL'?await h.sol(worker.vault):await h.usdc(worker.agent);
  await h.tx(`${asset} accept exact split`,[(await accept(workerOwner.address,employer.agent,worker.agent,split.escrow,terms,eid-1n,task.task)).instruction],[workerOwner]);
  assert.equal((asset==='SOL'?await h.sol(employer.vault):await h.usdc(employer.agent))-beforeEmployer,escrowAmount(asset)-workerShare);
  assert.equal((asset==='SOL'?await h.sol(worker.vault):await h.usdc(worker.agent))-beforeWorker,workerShare);assert.equal((await taskView()).pendingEscrows,'0');
  h.pass(`${asset} cooperative split conserves principal and exact reviewed terms`);
  const now=await h.rpc('getBlockTime',[await h.rpc('getSlot',[{commitment:'confirmed'}])]);assert.equal(typeof now,'number');
  const expires=BigInt(now)+10n;const expired=await makeEscrow(asset,'expiry refund',expires);const spentBefore=await taskView();
  const refund=(asset==='SOL'?await sdk.buildRefundExpiredEscrow(payer.address,employer.agent,expired.escrow,eid-1n,task.task):await sdk.buildRefundExpiredUsdcEscrow(payer.address,employer.agent,expired.escrow,eid-1n,task.task)).instruction;
  await h.tx('expiry refund rejects early caller',[refund],[],'EscrowNotExpired');
  for(let n=0;n<100;n++){if(BigInt(await h.rpc('getBlockTime',[await h.rpc('getSlot',[{commitment:'confirmed'}])]))>expires)break;await pause(200);}
  const before=asset==='SOL'?await h.sol(employer.vault):await h.usdc(employer.agent);await h.tx(`${asset} refund expired Escrow`,[refund]);
  assert.equal((asset==='SOL'?await h.sol(employer.vault):await h.usdc(employer.agent))-before,escrowAmount(asset));const after=await taskView();assert.equal(after.pendingEscrows,'0');assert.equal(after.sol.spent,spentBefore.sol.spent);assert.equal(after.usdc.spent,spentBefore.usdc.spent);
  h.pass(`${asset} expiry refunds principal without resetting Task gross spend`);
 }
 const selfInit=await sdk.buildInitializeAgent(payer.address,'Local same-owner Worker',5,1,100,20,['api','payment','escrow']);await h.tx('initialize same-owner fixture Worker',[selfInit.instruction]);await h.tx('fund same-owner Worker SOL Vault',[await sdk.buildDeposit(payer.address,selfInit.accounts.agent,selfInit.accounts.vault,0.001)]);
 const selfReputation=await h.data(selfInit.accounts.reputation);
 for(const asset of ['SOL','USDC'] as const){
  const same=await makeEscrow(asset,'same-owner settlement',deadline,selfInit.accounts.agent);await h.tx('same-owner Worker submits result',[await sdk.buildSubmitEscrowResult(payer.address,selfInit.accounts.agent,same.escrow,digest('same-owner fixture'))]);
  const release=asset==='SOL'?await sdk.buildReleaseEscrow(payer.address,employer.agent,es.session,session,same.escrow,selfInit.accounts.agent,eid-1n,task.task):await sdk.buildReleaseUsdcEscrow(payer.address,employer.agent,es.session,session,same.escrow,selfInit.accounts.agent,eid-1n,task.task);
  await h.tx(`${asset} same-owner principal settlement`,[release.instruction]);assert.deepEqual(await h.data(selfInit.accounts.reputation),selfReputation);assert.equal((await taskView()).pendingEscrows,'0');h.pass(`${asset} same-owner settlement cannot grow reputation`);
 }
 const memoryBefore=await h.api(`/api/memory/export?agent=${worker.agent}`);const jobsBefore=await h.api(`/api/worker/jobs?worker=${worker.agent}`);const historyBefore=await h.api('/api/activity');
 await h.restartRuntime();
 assert.deepEqual((await h.api(`/api/memory/export?agent=${worker.agent}`)).entries,memoryBefore.entries);assert.deepEqual((await h.api(`/api/worker/jobs?worker=${worker.agent}`)).jobs,jobsBefore.jobs);assert.deepEqual(await h.api('/api/activity'),historyBefore);h.pass('Runtime restart preserves verified Memory, Worker queue and planning history');
 for(const job of jobsBefore.jobs){const closed=await h.api('/api/worker/reconcile',{escrow:job.escrow});assert.ok(['delivered','closed'].includes(closed.job.state));const archived=await h.api('/api/worker/archive',{escrow:job.escrow,workerAgent:worker.agent,updatedAt:closed.job.updatedAt});assert.ok(archived.archiveFile.includes('/worker-archives/'));}
 assert.equal((await h.api(`/api/worker/jobs?worker=${worker.agent}`)).jobs.length,0);h.pass('Terminal Worker archive removes settled queue entries and retains complete records');
 // Task budget is gross spend; replacing its Session must not reset either amount.
 const beforeReplacement=await taskView();const newSigner=await generateKeyPairSigner();const replacement=await sdk.buildCreateSession(payer.address,employer.agent,employer.policy,newSigner.address,deadline+30n,1,2,10,30,['api','payment','escrow']);await h.tx('create replacement Session',[replacement.instruction]);
 await h.tx('replace Task Session',[(await sdk.buildReplaceTaskSession(payer.address,employer.agent,taskId,replacement.session)).instruction]);const afterReplacement=await taskView();assert.equal(afterReplacement.sol.spent,beforeReplacement.sol.spent);assert.equal(afterReplacement.usdc.spent,beforeReplacement.usdc.spent);
 await h.tx('complete settled Task',[(await sdk.buildSetTaskStatus(payer.address,employer.agent,taskId,'completed',digest('local final answer'))).instruction]);assert.equal((await taskView()).status,'completed');h.pass('Task completion and Session replacement retain independent accounting');
 const rep=await h.data(worker.reputation);assert.equal(rep.readBigUInt64LE(40)-countBefore,6n);h.pass('Reputation reflects settlement outcomes',{completed:rep.readBigUInt64LE(40).toString()});
 const memory=await h.api(`/api/memory/export?agent=${worker.agent}`);assert.equal(memory.network,'localnet-preview');assert.ok(JSON.stringify(memory).includes(source.hash));
 h.pass('Verified Memory export contains real local-chain source');
 const resultDirectory=await h.api(`/api/on-chain/task-skill-results?agent=${employer.agent}&task=${task.task}`);assert.equal(resultDirectory.count,2);assert.ok(resultDirectory.results.every((r:any)=>r.outputHash));h.pass('Task result directory reads both committed assets');
 for(const name of ['agentos_task_plan','agentos_worker_draft','agentos_escrow_judgment','agentos_final_response'])assert.ok(fixture.requests.includes(name),`Missing ${name} fixture request`);
 h.pass('All model protocol stages exercised with explicitly labelled fixtures',{schemas:fixture.requests});
 console.log('ALL CURRENT LOCAL FLOW CHECKS PASSED');
 await h.finish();
} catch(error) {console.error(error);if(h.root)await h.finish(error);process.exitCode=1;} finally {if(modelServer)await new Promise<void>(resolve=>modelServer!.close(()=>resolve()));if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));}

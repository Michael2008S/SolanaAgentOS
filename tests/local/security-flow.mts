import assert from 'node:assert/strict';
import { LocalHarness, digest } from './harness.mts';
import * as sdk from '../../apps/web/src/lib/agentOs.ts';
const h = new LocalHarness();
try {
 await h.start(); const init = await h.prepareReview(); await h.authorize();
 const {payer, session, provider, workerSession} = h.signers;
 const a = init.accounts;
 await h.tx('initialize security Agent', [init.instruction]);
 await h.tx('deposit security SOL', [await sdk.buildDeposit(payer.address,a.agent,a.vault,0.1)]);
 const clock = async()=>BigInt(await h.rpc('getBlockTime',[await h.rpc('getSlot',[{commitment:'confirmed'}])]));
 const create = async(signer:typeof session,expires:bigint,permissions:('api'|'payment')[])=>{
  const s=await sdk.buildCreateSession(payer.address,a.agent,a.policy,signer.address,expires,0.01,0.02,1,2,permissions);
  await h.tx('create bounded security Session',[s.instruction]); return s;
 };
 const s=await create(session,await clock()+120n,['payment']);
 const pay=async(amount:number,id:bigint,key=session)=>sdk.buildExecutePayment(payer.address,a.agent,a.policy,a.vault,s.session,key,provider.address,amount,digest('security input'),digest('security output'),id);
 const unchanged=async(operation:()=>Promise<unknown>)=>{
  const before=await Promise.all([h.data(a.policy),h.data(s.session),h.sol(a.vault)]);
  await operation();assert.deepEqual(await Promise.all([h.data(a.policy),h.data(s.session),h.sol(a.vault)]),before);
 };
 await unchanged(async()=>h.tx('overspend blocked without changing balances',[(await pay(0.011,0n)).instruction],[],'PerTransactionLimitExceeded'));
 await unchanged(async()=>h.tx('foreign Session signer rejected',[(await pay(0.001,0n,workerSession)).instruction],[],'ConstraintSeeds'));
 const valid=await pay(0.001,0n);await h.tx('bounded authorized payment succeeds',[valid.instruction]);
 await unchanged(async()=>h.tx('Execution replay rejected',[valid.instruction],[],'already in use'));
 await h.tx('pause Policy',[await sdk.buildUpdatePolicy(payer.address,a.agent,a.policy,5,1,100,20,['api','payment','escrow'],true)]);
 await unchanged(async()=>h.tx('paused Policy rejects payment',[(await pay(0.001,1n)).instruction],[],'PolicyPaused'));
 await h.tx('resume Policy',[await sdk.buildUpdatePolicy(payer.address,a.agent,a.policy,5,1,100,20,['api','payment','escrow'])]);
 await h.tx('revoke security Session',[(await sdk.buildRevokeSession(payer.address,a.agent,session.address)).instruction]);
 await unchanged(async()=>h.tx('revoked Session rejects payment',[(await pay(0.001,1n)).instruction],[],'SessionRevoked'));
 const expiry=await clock()+8n;const short=await create(workerSession,expiry,['api']);
 const denied=await sdk.buildExecutePayment(payer.address,a.agent,a.policy,a.vault,short.session,workerSession,provider.address,0.001,digest('permission'),digest('permission'),1n);
 await h.tx('API-only Session cannot transfer',[denied.instruction],[],'InvalidPermission');
 for(let n=0;n<100 && await clock()<expiry;n++)await new Promise(r=>setTimeout(r,200));
 assert.ok(await clock()>=expiry);await h.tx('expired Session rejects payment',[denied.instruction],[],'InvalidSession');
 h.pass('Security rejection simulations preserve stored state and funds');await h.finish();
}catch(e){console.error(e);if(h.root)await h.finish(e);process.exitCode=1;}

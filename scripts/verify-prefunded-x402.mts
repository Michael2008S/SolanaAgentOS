import assert from 'node:assert/strict';
import { decodePaymentSignatureHeader,decodePaymentResponseHeader } from '@x402/core/http';
import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Decoder,getPublicKeyFromAddress,verifySignature } from '@solana/kit';
import { verifyPrefundedX402Settlement } from '../apps/runtime/src/prefunded-x402-payment.ts';
import { verifyAutonomousTransaction } from '../apps/runtime/src/autonomous-proof.ts';
import { parseAutonomousJob } from '../apps/runtime/src/autonomous-loop.ts';
import { parseStandardTools,standardToolTerms } from '../apps/runtime/src/standard-tools.ts';
import { readStandardChallenge } from '../apps/runtime/src/standard-payments.ts';
if(process.argv.length!==3)throw new Error('Provide the isolated prefunded x402 evidence directory.');
const directory=resolve(process.argv[2]),load=async(name:string)=>JSON.parse(await readFile(join(directory,name),'utf8')),hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const report=await load('report.json'),job=parseAutonomousJob(await load('completed-job.json')),outputs=await load('gateway-outputs.json');
assert.equal(report.status,'passed');assert.equal(job.state,'completed');assert.equal(report.totalTransactions,12);assert.equal(report.transactions.length,12);assert.equal(outputs.length,2);assert.equal(job.intents.length,2);
const transactions=new Map<string,any>();
for(const row of report.transactions){
 assert.match(row.signature,/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);assert.ok(!transactions.has(row.signature));
 const raw=await readFile(join(directory,row.signature+'.json'),'utf8');assert.equal(hash(raw),row.sha256);
 const result=JSON.parse(raw).result;assert.equal(result.meta.err,null);assert.equal(result.meta.fee,row.fee);assert.ok(row.fee<=10000);assert.equal(result.slot,row.slot);
 const tx=getTransactionDecoder().decode(Buffer.from(result.transaction[0],'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 assert.notEqual(message.version,1);if(message.version===1)throw new Error('Unexpected v1 evidence');assert.equal(getBase58Decoder().decode(tx.signatures[message.staticAccounts[0]]!),row.signature);
 for(const key of message.staticAccounts.slice(0,message.header.numSignerAccounts))assert.ok(await verifySignature(await getPublicKeyFromAddress(key),tx.signatures[key]!,tx.messageBytes));
 transactions.set(row.signature,result);
}
const tools=parseStandardTools(JSON.stringify(report.identity.tools)),reserved=parseAutonomousJob({...job,state:'executing',intents:job.intents.map(({receipt,...intent})=>({...intent,phase:'reserved'}))});
const rpc=async(method:string,params:unknown[])=>{if(method==='getGenesisHash')return job.genesis;if(method==='getTransaction'){assert.equal((params[1] as any).commitment,'finalized');const result=transactions.get(String(params[0]));assert.ok(result,'Missing original transaction evidence');return result;}throw new Error('Offline verifier cannot access network: '+method);};
const checked=[];
for(const output of outputs){
 const intent=job.intents.find(value=>value.id===output.intentId);assert.ok(intent);const tool=tools.find(value=>value.id===intent.action.tool);assert.ok(tool);assert.equal(tool.x402Mode,'prefunded');
 const challenge=readStandardChallenge(new Response(null,{status:402,headers:{'payment-required':output.paymentChallenge}}),standardToolTerms(tool,'localnet',job.genesis),0);assert.equal(challenge.protocol,'x402');if(challenge.protocol!=='x402')throw new Error('Wrong protocol');
 const verified=await verifyPrefundedX402Settlement({job:reserved,action:intent.action,intentId:intent.id,sessionKey:report.identity.sessionKey,fundingFeePayer:report.identity.feePayer,recipient:tool.recipient,endpoint:tool.endpoint,challenge,rpc,fundingSignature:output.fundingSignature,settlementSignature:output.paymentSignature,partialWire:output.sponsoredPayment.wire,memo:output.sponsoredPayment.memo});
 assert.equal(verified.scope.execution,output.execution);assert.equal(intent.receipt?.output,output.content);assert.equal(intent.receipt?.outputHash,hash(output.content));
 await verifyAutonomousTransaction(rpc,output.resultSignature,job.program,verified.scope.resultAccounts,verified.scope.resultData(output.content),report.identity.feePayer,report.identity.sessionKey);
 const meta=verified.settlement.meta;assert.equal(meta.preBalances[0]-meta.postBalances[0],meta.fee);
 for(const [owner,expected] of [[tool.recipient,BigInt(tool.amount)],[report.identity.sessionKey,-BigInt(tool.amount)]] as const){
  const before=meta.preTokenBalances.find((value:any)=>value.owner===owner),after=meta.postTokenBalances.find((value:any)=>value.owner===owner);assert.ok(before&&after);assert.equal(before.mint,challenge.accepted.asset);assert.equal(after.mint,challenge.accepted.asset);assert.equal(BigInt(after.uiTokenAmount.amount)-BigInt(before.uiTokenAmount.amount),expected);
 }
 checked.push({intentId:intent.id,execution:output.execution,fundingSignature:output.fundingSignature,settlementSignature:output.paymentSignature,resultSignature:output.resultSignature,outputHash:hash(output.content)});
}
let interruptedCheckpointVerified=false;
if(report.checkpointInterruption){
 const before=parseAutonomousJob(await load('interrupted-job.json')),record=await load('interrupted-gateway-record.json');
 assert.equal(before.state,'needs_reconciliation');assert.equal(before.id,job.id);assert.equal(before.genesis,job.genesis);assert.equal(before.program,job.program);assert.deepEqual(before.limits,job.limits);assert.equal(before.intents.length,1);assert.equal(before.intents[0].phase,'reserved');assert.equal(before.modelRequests,1);assert.equal(before.spent.usdc,'1000');
 assert.equal(record.complete,false);assert.equal(record.intentId,before.intents[0].id);assert.equal(record.jobId,job.id);assert.equal(record.tenant,job.tenant);
 const restored=outputs.find((value:any)=>value.intentId===record.intentId);assert.ok(restored);assert.equal(restored.fundingSignature,record.funding.signature);assert.equal(restored.paymentSignature,record.payment.signature);if(['before-result-signing','response-body-lost'].includes(report.checkpointInterruption.stage)){assert.equal(record.result,undefined);assert.equal(report.resultSignerCalls,2);assert.equal(report.checkpointInterruption.resultSignerCallsBeforeRecovery,0);assert.equal(report.checkpointInterruption.missingResultSignedOnce,true);if(report.checkpointInterruption.stage==='before-result-signing')assert.equal(report.persistedBeforeSignedSimulation,true);}else assert.equal(restored.resultSignature,record.result.signature);if(report.checkpointInterruption.stage==='response-body-lost'){assert.equal(record.content,undefined);assert.equal(report.cacheHits,1);assert.equal(report.cachedResponseRecoveredWithoutPayment,true);assert.equal(report.cacheRetrievals[0].content,restored.content);assert.equal(report.cacheRetrievals[0].identifier,'pay_'+record.intentId);assert.equal(report.cacheRetrievals[0].headerUnchanged,true);const credential=decodePaymentSignatureHeader(record.paymentHeader),receipt=decodePaymentResponseHeader(report.cacheRetrievals[0].receipt);assert.equal(credential.payload.transaction,record.sponsoredPayment.wire);assert.equal((credential.extensions?.['payment-identifier'] as any)?.info?.id,'pay_'+record.intentId);assert.equal(receipt.success,true);assert.equal(receipt.transaction,record.payment.signature);assert.equal(receipt.network,'solana:'+job.genesis.slice(0,32));}else assert.equal(restored.content,record.content);assert.deepEqual(restored.sponsoredPayment,record.sponsoredPayment);assert.equal(restored.paymentChallenge,record.paymentChallenge);
 assert.equal(record.funding.wire,transactions.get(restored.fundingSignature).transaction[0]);assert.equal(record.payment.wire,transactions.get(restored.paymentSignature).transaction[0]);if(record.result)assert.equal(record.result.wire,transactions.get(restored.resultSignature).transaction[0]);
 assert.equal(report.checkpointInterruption.transactionsBeforeRecovery,['result-before-broadcast','before-result-signing','response-body-lost'].includes(report.checkpointInterruption.stage)?8:9);assert.equal(report.checkpointInterruption.paidHttpCallsBeforeRecovery,1);assert.equal(report.checkpointInterruption.modelCallsBeforeRecovery,1);if(record.result)assert.equal(report.checkpointInterruption.originalResultSignature,record.result.signature);else assert.equal(report.checkpointInterruption.originalResultSignature,undefined);assert.equal(report.checkpointInterruption.recoveredResultSignature,restored.resultSignature);assert.equal(report.checkpointInterruption.automaticStartupRecoveryWithoutReplay,true);
 assert.equal(job.modelRequests,2);assert.equal(job.spent.usdc,'2000');assert.equal(report.modelFixtureRequests,2);assert.equal(report.paidHttpCalls,2);assert.equal(report.sponsorSigningRequests,2);
 interruptedCheckpointVerified=true;
}
let centralTakeoverVerified=false;
if(report.remoteTaskStorage){
 const before=parseAutonomousJob(await load('interrupted-job.json'));
 for(const field of ['id','tenant','agent','session','program','genesis','limits','goal'] as const)assert.deepEqual(before[field],job[field]);
 assert.equal(before.pending.length,1);assert.deepEqual(before.pending[0],job.intents[1].action);assert.equal(before.intents[0].id,job.intents[0].id);assert.deepEqual(before.intents[0].action,job.intents[0].action);
 assert.equal(report.workerDatabaseFilesAbsent,true);assert.equal(report.remainingOriginalPlanCompleted,true);assert.equal(report.centralProcessRestarted,true);assert.equal(report.centralAgentLeaseHeldBeforeCrash,true);assert.equal(report.centralLeaseRecovered,true);assert.equal(report.cumulativeUsdc,'2000');
 for(const name of ['centralBeforePid','centralAfterPid','centralCompletedRestartPid','workerBeforePid','workerAfterPid'])assert.ok(Number.isSafeInteger(report[name])&&report[name]>0);
 assert.notEqual(report.centralBeforePid,report.centralAfterPid);assert.notEqual(report.centralAfterPid,report.centralCompletedRestartPid);assert.notEqual(report.workerBeforePid,report.workerAfterPid);
 const commands=report.coordinationCommands;assert.ok(Array.isArray(commands));for(const command of commands){assert.equal(command.tenant,job.tenant);if(command.id)assert.equal(command.id,job.id);if(command.hash)assert.match(command.hash,/^[a-f0-9]{64}$/);}
 assert.equal(commands.filter(command=>command.op==='create').length,1);assert.ok(commands.filter(command=>command.op==='acquire').length>=2);assert.ok(commands.filter(command=>command.op==='save').length>=5);assert.ok(commands.filter(command=>command.op==='release').length>=2);
 centralTakeoverVerified=true;
}
const verification={status:'passed',scope:'Offline cryptographic and captured finalized transaction verification; does not prove production deployment, RPC authenticity or real-model quality',transactions:transactions.size,payments:checked,interruptedCheckpointVerified,...(centralTakeoverVerified?{centralTakeoverVerified:true,centralCoordinationEvidence:'Same-host process, lease and file observations; no production cross-host transport proof.',remainingOriginalPlanVerified:true,cumulativeBudgetRetained:true}:{}),originalBudgetFundingVerified:true,originalStandardTransferVerified:true,recipientAndSourceTokenDeltasVerified:true,sponsorOnlyPaidNetworkFee:true,outputCommitmentsVerified:true};
await writeFile(join(directory,'verification.json'),JSON.stringify(verification,null,2)+'\n');console.log(JSON.stringify({status:verification.status,transactions:verification.transactions,payments:checked.length}));

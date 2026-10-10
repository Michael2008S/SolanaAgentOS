import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Decoder,getPublicKeyFromAddress,verifySignature } from '@solana/kit';
import { notificationEvent } from '../apps/runtime/src/autonomous-notification-types.ts';
import { parseAutonomousJob } from '../apps/runtime/src/autonomous-loop.ts';
if(process.argv.length!==3)throw new Error('Provide a Runtime notification evidence directory.');
const root=resolve(process.argv[2]),read=async(name:string)=>JSON.parse(await readFile(join(root,name),'utf8'));
const report=await read('report.json'),job=parseAutonomousJob(await read('completed-job.json')),events=(await read('notification-events.json')).map((event:unknown)=>notificationEvent.parse(event)),status=await read('notification-status.json');
assert.equal(report.status,'passed');assert.equal(report.totalTransactions,2);assert.equal(report.transactions.length,2);assert.equal(job.state,'completed');assert.equal(job.modelRequests,2);assert.equal(job.intents.length,0);assert.deepEqual(job.spent,{sol:'0',usdc:'0'});
assert.equal(events.length,2);assert.deepEqual(events[0],events[1]);assert.equal(events[0].jobId,job.id);assert.equal(events[0].tenant,job.tenant);assert.equal(events[0].state,'completed');assert.equal(events[0].cycle,job.cycle);assert.deepEqual(events[0].spent,job.spent);
assert.equal(status.configured,true);assert.equal(status.deliveries.length,1);assert.equal(status.deliveries[0].id,events[0].id);assert.equal(status.deliveries[0].jobId,job.id);assert.equal(status.deliveries[0].status,'sent');assert.equal(status.deliveries[0].attempts,2);assert.equal(status.deliveries[0].destinationChanged,false);
const allowed=new Set(['initialize_agent','create_session'].map(name=>createHash('sha256').update('global:'+name).digest().subarray(0,8).toString('hex')));
for(const item of report.transactions){
 const raw=await readFile(join(root,item.signature+'.json'),'utf8');assert.equal(createHash('sha256').update(raw).digest('hex'),item.sha256);const rpc=JSON.parse(raw).result;assert.equal(rpc.meta.err,null);assert.equal(rpc.meta.fee,5000);
 const tx=getTransactionDecoder().decode(Buffer.from(rpc.transaction[0],'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes),keys=message.staticAccounts.slice(0,message.header.numSignerAccounts);
 assert.equal(getBase58Decoder().decode(tx.signatures[keys[0]]!),item.signature);for(const key of keys)assert.ok(await verifySignature(await getPublicKeyFromAddress(key),tx.signatures[key]!,tx.messageBytes));
 assert.equal(message.instructions.length,1);const instruction=message.instructions[0];assert.equal(message.staticAccounts[instruction.programAddressIndex],job.program);assert.ok(allowed.delete(Buffer.from(instruction.data!).subarray(0,8).toString('hex')));
}
assert.equal(allowed.size,0);assert.equal(report.notificationHttpRequests,2);assert.equal(report.receiverEffectsAfterDeduplication,1);assert.equal(report.modelFixtureRequests,2);assert.equal(report.realModelQuotaUnchanged,true);assert.equal(report.restartedAfterAcceptedBeforeAcknowledged,true);assert.equal(report.originalJobNotReexecuted,true);assert.equal(report.receiverAuthenticationVerified,true);
const verification={status:'passed',transactionsVerified:2,notificationRequests:2,uniqueEvent:events[0].id,checks:['original checksums and all transaction signatures','only Agent and Session preparation transactions','completed original job, no tool/payment intents and zero gross spend','same tenant/job/state/id/payload after restart','durable delivery acknowledgement and two attempts','fixture observed HMAC authentication and receiver deduplication'],limitations:['Local HTTP receiver and local model fixture, not production messaging or real-model quality.','Network delivery is at-least-once; receiver deduplication is required.']};
await writeFile(join(root,'verification.json'),JSON.stringify(verification,null,2)+'\n');console.log(JSON.stringify(verification));

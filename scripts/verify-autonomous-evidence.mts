import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { getTransactionDecoder,getCompiledTransactionMessageDecoder,getPublicKeyFromAddress,verifySignature,getBase58Decoder } from '@solana/kit';
import { autonomousSkillScope,autonomousServiceScope,verifyAutonomousTransaction } from '../apps/runtime/src/autonomous-proof.ts';
import { readStandardChallenge,standardCredential,verifyStandardReceipt } from '../apps/runtime/src/standard-payments.ts';
import { standardToolTerms } from '../apps/runtime/src/standard-tools.ts';
import { verifySponsoredSettlement } from '../apps/runtime/src/standard-settlement.ts';
if(process.argv.length!==3)throw new Error('Provide an autonomous acceptance evidence directory.');
const root=resolve(process.argv[2]),report=JSON.parse(await readFile(join(root,'report.json'),'utf8'));
const job=JSON.parse(await readFile(join(root,'completed-job.json'),'utf8'));
const sha=(data:string)=>createHash('sha256').update(data).digest('hex');
const rows:any[]=[];
assert.equal(report.status,'passed');assert.equal(report.transactions.length,report.totalTransactions);assert.ok(report.totalTransactions<=12);assert.equal(job.intents.length,2);
for(const record of report.transactions){
 const raw=await readFile(join(root,record.signature+'.json'),'utf8');assert.equal(sha(raw),record.sha256);
 const rpc=JSON.parse(raw).result;assert.equal(rpc.meta.err,null);assert.ok(rpc.meta.fee<=10000);
 const tx=getTransactionDecoder().decode(Buffer.from(rpc.transaction[0],'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 const signers=message.staticAccounts.slice(0,message.header.numSignerAccounts);
 assert.equal(getBase58Decoder().decode(tx.signatures[signers[0]]!),record.signature);
 for(const key of signers)assert.equal(await verifySignature(await getPublicKeyFromAddress(key),tx.signatures[key]!,tx.messageBytes),true);
 rows.push({signature:record.signature,rpc,message});
}
const rpc=async(method:string,params:unknown[])=>method==='getGenesisHash'?job.genesis:rows.find(row=>row.signature===params[0])?.rpc??null;
const used=new Set<string>();
if(report.identity?.tools){
 const outputs=JSON.parse(await readFile(join(root,'gateway-outputs.json'),'utf8'));
 for(const intent of job.intents){
  const tool=report.identity.tools.find((tool:any)=>tool.id===intent.action.tool),value=outputs.find((output:any)=>output.intentId===intent.id);assert.ok(tool&&value);
  const challenge=readStandardChallenge(new Response(null,{status:402,headers:{[tool.protocol==='x402'?'payment-required':'www-authenticate']:value.paymentChallenge}}),standardToolTerms(tool,'localnet',job.genesis),0);
  let memo=challenge.memo,paymentFeePayer=report.identity.feePayer;
  if(challenge.protocol==='x402'){
   assert.ok(value.sponsoredPayment);assert.equal(value.sponsoredPayment.sponsor,challenge.accepted.extra.feePayer);
   memo=value.sponsoredPayment.memo;if(challenge.memo!==undefined)assert.equal(memo,challenge.memo);else assert.match(memo!,/^[a-f0-9]{32}$/);
   paymentFeePayer=value.sponsoredPayment.sponsor;
   await verifySponsoredSettlement({rpc,genesis:job.genesis,signature:value.paymentSignature,partialWire:value.sponsoredPayment.wire,sponsor:paymentFeePayer,clientSigners:[report.identity.sessionKey],allowedSponsorAccounts:paymentFeePayer===tool.recipient?[{instruction:0,account:7}]:[]});
   const row=rows.find(row=>row.signature===value.paymentSignature);assert.ok(row);const index=row.message.staticAccounts.indexOf(paymentFeePayer);
   assert.equal(row.rpc.meta.preBalances[index]-row.rpc.meta.postBalances[index],row.rpc.meta.fee);
  }
  const scope=await autonomousServiceScope({job,action:intent.action,intentId:intent.id,feePayer:report.identity.feePayer,sessionKey:report.identity.sessionKey,...(challenge.protocol==='x402'?{rentPayer:report.identity.sessionKey}:{}),recipient:tool.recipient,endpoint:tool.endpoint,memo});
  assert.equal(value.execution,scope.execution);assert.equal(intent.receipt.id,scope.execution);assert.equal(value.content,intent.receipt.output);assert.equal(sha(value.content),intent.receipt.outputHash);
  for(const [signature,accounts,data,extra,feePayer] of [[value.paymentSignature,scope.accounts,scope.paymentData,scope.extra,paymentFeePayer],[value.resultSignature,scope.resultAccounts,scope.resultData(value.content),[],report.identity.feePayer]] as const){
   assert.ok(!used.has(signature));used.add(signature);await verifyAutonomousTransaction(rpc,signature,job.program,accounts,data,feePayer,report.identity.sessionKey,extra);
  }
 }
 if(report.identity.tools.every((tool:any)=>tool.protocol==='mpp')){
  assert.equal(report.apiOnlySessionRejected,true);
  if(report.cachedResponseRecoveredWithoutPayment){
   assert.equal(report.cacheHits,2);assert.equal(report.paidHttpCalls,2);assert.equal(report.totalTransactions,10);assert.equal(report.actualRuntimeRestart,true);assert.equal(new Set(report.runtimePids).size,3);
   const completed=JSON.parse(await readFile(join(root,'completed-gateway-records.json'),'utf8'));
   assert.equal(report.interruptions.length,2);assert.equal(report.cacheRetrievals.length,2);assert.equal(completed.length,2);
   for(const intent of job.intents){
    const original=JSON.parse(await readFile(join(root,'interrupted-'+intent.action.asset+'-record.json'),'utf8')),saved=completed.find((record:any)=>record.intentId===intent.id),tool=report.identity.tools.find((tool:any)=>tool.id===intent.action.tool),cached=report.cacheRetrievals.find((item:any)=>item.signature===original.payment.signature);
    assert.ok(saved&&tool&&cached);assert.equal(tool.recoverResponse,true);assert.equal(original.content,undefined);assert.equal(original.result,undefined);assert.equal(saved.responseRecoveries,1);assert.equal(saved.complete,true);
    for(const field of ['tenant','jobId','intentId','scopeHash','execution','paymentChallenge','paymentHeader','payment'])assert.deepEqual(saved[field],original[field]);
    const terms=standardToolTerms(tool,'localnet',job.genesis),challenge=readStandardChallenge(new Response(null,{status:402,headers:{'www-authenticate':original.paymentChallenge}}),terms,0);
    assert.equal(original.paymentHeader,standardCredential(challenge,{signature:original.payment.signature}).value);
    assert.equal(rows.find(row=>row.signature===original.payment.signature)?.rpc.transaction[0],original.payment.wire);
    assert.equal(cached.headerUnchanged,true);assert.equal(cached.inputUnchanged,true);assert.equal(cached.content,saved.content);assert.equal(saved.content,intent.receipt.output);
    verifyStandardReceipt(new Response(cached.content,{headers:{'payment-receipt':cached.receipt}}),challenge,original.payment.signature,terms);
   }
  }
 }
 else {assert.equal(report.officialSdkVerified,true);assert.equal(report.sponsorOnlyPaidNetworkFee,true);assert.equal(report.defaultUnsupportedWalletRejected,true);}
}else{
const registration=rows.find(row=>row.message.instructions.some((instruction:any)=>Buffer.from(instruction.data??[]).subarray(0,8).equals(createHash('sha256').update('global:register_skill').digest().subarray(0,8))));assert.ok(registration);
const registrationInstruction=registration.message.instructions[0],provider=registration.message.staticAccounts[registrationInstruction.accountIndices[0]];
const identities=report.originalIdentity??report.cachedIdentity;
// Older acceptance directories lack identities; this verifier requires the restart fixture's public identity record.
assert.ok(identities);if(report.cachedIdentity){assert.equal(report.cachedResponseRecovery.actualRuntimeRestart,true);assert.equal(report.cachedResponseRecovery.cachedReads,1);assert.equal(report.cachedResponseRecovery.toolExecutions,2);}else assert.deepEqual(identities,report.restartedIdentity);
const fixed=identities.identities[0];assert.equal(fixed.agent,job.agent);assert.equal(fixed.session,job.session);
for(const intent of job.intents){
 const scope=await autonomousSkillScope({job,action:intent.action,intentId:intent.id,feePayer:identities.feePayer,sessionKey:fixed.sessionKey,provider});
 assert.equal(scope.execution,intent.receipt.id);assert.equal(sha(intent.receipt.output),intent.receipt.outputHash);
 assert.ok(registrationInstruction.accountIndices.some((index:number)=>registration.message.staticAccounts[index]===intent.action.tool));
 for(const [accounts,data] of [[scope.accounts,scope.paymentData],[scope.resultAccounts,scope.resultData(intent.receipt.output)]] as const){
  const row=rows.find(row=>row.message.instructions.length===1&&Buffer.from(row.message.instructions[0].data??[]).equals(data));assert.ok(row);assert.ok(!used.has(row.signature));used.add(row.signature);
  await verifyAutonomousTransaction(rpc,row.signature,job.program,accounts,data,identities.feePayer,fixed.sessionKey);
 }
}
}
assert.equal(used.size,4);assert.deepEqual(job.intents.map((intent:any)=>intent.executionId),['0','1']);
const result={status:'passed',transactionsVerified:rows.length,paidIntentsVerified:job.intents.length,checks:['saved checksum','all required Ed25519 signatures','exact payment accounts/data and allocated counter','exact result commitment accounts/data','original output SHA-256',report.identity?.tools?'fixed quote and exact challenge memo':report.cachedIdentity?'fixed cached-response recovery identity':'stable gateway identity across process restart',...(report.identity?.tools.some((tool:any)=>tool.protocol==='x402')?['original partial message and client signatures unchanged','pinned sponsor and client signer set','sponsor SOL debit equals network fee']:[]),...(report.cachedResponseRecoveredWithoutPayment&&report.identity?.tools.every((tool:any)=>tool.protocol==='mpp')?['original MPP credential and finalized wire unchanged across recovery','cached receipt binds original challenge and signature','one persisted cache attempt per asset and unchanged output commitment']:[])],realModelQuotaUsed:'unchanged'};
await writeFile(join(root,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));

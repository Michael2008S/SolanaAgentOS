import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { address,getAddressEncoder,getProgramDerivedAddress,getTransactionDecoder,getCompiledTransactionMessageDecoder,getSignatureFromTransaction,getPublicKeyFromAddress,verifySignature } from '@solana/kit';
import { canonicalJson } from '../apps/runtime/src/canonical-json.js';
import { judgeRecordInput,judgeRecordReceipt } from '../apps/runtime/src/judge-record-protocol.js';
import { verifyJudgedSettlementWire } from '../apps/runtime/src/judge-settlement-proof.js';
const directory=resolve(process.argv[2]??''),report=JSON.parse(await readFile(join(directory,'report.json'),'utf8')),sha=(text:string)=>createHash('sha256').update(text).digest(),enc=getAddressEncoder();
assert.equal(report.status,'passed');assert.equal(report.judgments.length,3);
const pda=async(prefix:string,key:string)=>String((await getProgramDerivedAddress({programAddress:address(report.program),seeds:[Buffer.from(prefix),enc.encode(address(key))]}))[0]);
assert.equal(String((await getProgramDerivedAddress({programAddress:address(report.program),seeds:[Buffer.from('session'),enc.encode(address(report.judge)),enc.encode(address(report.sessionKey))]}))[0]),report.session);
const proofs=[];
for(const [index,item] of report.judgments.entries()){
 const input=judgeRecordInput.parse(item.input),receipt=judgeRecordReceipt.parse(item.receipt),result=JSON.parse(await readFile(join(directory,`judge-${index}-transaction.json`),'utf8'));
 assert.equal(input.judgment.verdict,['pass','fail','needs_review'][index]);assert.equal(result.meta.err,null);assert.ok(Number.isSafeInteger(result.meta.fee)&&result.meta.fee>=0&&result.meta.fee<=10000);assert.equal(result.meta.fee,item.fee);
 const tx=getTransactionDecoder().decode(Buffer.from(result.transaction[0],'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 assert.equal(message.version,0);if(message.version!==0)throw new Error('Expected v0');assert.equal(String(getSignatureFromTransaction(tx)),receipt.signature);assert.equal(message.header.numSignerAccounts,2);assert.equal(message.instructions.length,1);assert.equal(message.staticAccounts[0],report.feePayer);assert.deepEqual(new Set(message.staticAccounts.slice(0,2)),new Set([report.feePayer,report.sessionKey]));
 for(const key of message.staticAccounts.slice(0,2))assert.ok(await verifySignature(await getPublicKeyFromAddress(key),tx.signatures[key]!,tx.messageBytes));
 const ix=message.instructions[0],keys=(ix.accountIndices??[]).map(index=>message.staticAccounts[index]),decision=await pda('escrow_decision',input.escrow),judgmentHash=sha(canonicalJson(input.judgment)).toString('hex');
 assert.equal(message.staticAccounts[ix.programAddressIndex],report.program);assert.deepEqual(keys,[report.sessionKey,report.feePayer,report.judge,await pda('policy',report.judge),report.session,input.escrow,await pda('escrow_judge',input.escrow),decision,'11111111111111111111111111111111']);
 assert.deepEqual(Buffer.from(ix.data??[]),Buffer.concat([sha('global:record_escrow_judgment').subarray(0,8),Buffer.from([index]),Buffer.from(input.taskHash,'hex'),Buffer.from(input.resultHash,'hex'),Buffer.from(judgmentHash,'hex')]));
 assert.deepEqual({...receipt,signature:undefined,commitment:undefined},{tenant:input.tenant,escrow:input.escrow,decision,taskHash:input.taskHash,resultHash:input.resultHash,judgmentHash,verdict:input.judgment.verdict,signature:undefined,commitment:undefined});
 proofs.push({signature:receipt.signature,slot:result.slot,fee:result.meta.fee,verdict:receipt.verdict});
}
if(report.runtimeQueue){
 const before=JSON.parse(await readFile(join(directory,'queue-before-restart.json'),'utf8')),after=JSON.parse(await readFile(join(directory,'queue-after-restart.json'),'utf8')),requests=JSON.parse(await readFile(join(directory,'gateway-requests.json'),'utf8'));
 assert.equal(before.state,'blocked');assert.equal(after.state,report.runtimeSettlement?'settled':'recorded');assert.ok(before.attempts>=1&&after.attempts>=1&&after.attempts<=3);if(!report.runtimeSettlement)assert.ok(after.attempts>before.attempts);assert.ok(requests.length>=2&&requests.length<=3);for(const request of requests)assert.deepEqual(request,report.judgments[0].input);assert.equal(report.localModelRequests,1);assert.equal(report.realModelRequests,0);assert.equal(report.actualRuntimeRestart,true);assert.equal(report.completedRestartDoesNotRegenerateOrRecord,true);
 if(report.runtimeSettlement){const tx=JSON.parse(await readFile(join(directory,'settlement-transaction.json'),'utf8'));assert.equal(tx.meta.err,null);assert.ok(Number.isSafeInteger(tx.meta.fee)&&tx.meta.fee>=0&&tx.meta.fee<=10000);assert.equal(report.settlementCalls,1);await verifyJudgedSettlementWire(report.program,report.employer,report.worker,report.settlementInput,report.settlementReceipt,tx.transaction[0]);proofs.push({signature:report.settlementReceipt.signature,slot:tx.slot,fee:tx.meta.fee,verdict:report.settlementReceipt.verdict,kind:'settlement'});}
}
const verification={passed:true,scope:'Captured Judge wires and optional settlement: cryptographic signatures, exact instruction/accounts, Session and Decision PDAs, structured assessment hashes, canonical settlement destination and fees. Finalization, live mandate/Owner checks, journal recovery and request counters remain fixture observations; no model quality or production Vault proof.',proofs,checkedAt:new Date().toISOString()};
await writeFile(join(directory,'verification.json'),JSON.stringify(verification,null,2)+'\n');console.log(JSON.stringify(verification));

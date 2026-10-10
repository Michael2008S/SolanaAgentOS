import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Decoder,getPublicKeyFromAddress,verifySignature } from '@solana/kit';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { verifyPrefundedX402Settlement } from '../apps/runtime/src/prefunded-x402-payment.ts';
import { verifyAutonomousTransaction } from '../apps/runtime/src/autonomous-proof.ts';
import { parseAutonomousJob } from '../apps/runtime/src/autonomous-loop.ts';
import { readStandardChallenge } from '../apps/runtime/src/standard-payments.ts';
if(process.argv.length!==3)throw new Error('Provide the failed result-broadcast recovery evidence directory.');
const directory=resolve(process.argv[2]),load=async(name:string)=>JSON.parse(await readFile(join(directory,name),'utf8')),hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const report=await load('report.json'),job=parseAutonomousJob(await load('interrupted-job.json')),record=await load('interrupted-gateway-record.json');
assert.equal(report.status,'failed');assert.equal(report.checkpointInterruption.stage,'result-before-broadcast');assert.equal(report.transactions.length,9);assert.equal(record.complete,false);assert.equal(job.state,'needs_reconciliation');
const transactions=new Map<string,any>();
for(const row of report.transactions){
 assert.match(row.signature,/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);assert.ok(!transactions.has(row.signature));const raw=await readFile(join(directory,row.signature+'.json'),'utf8');assert.equal(hash(raw),row.sha256);const result=JSON.parse(raw).result;assert.equal(result.meta.err,null);assert.equal(result.meta.fee,row.fee);assert.ok(row.fee<=10000);assert.equal(result.slot,row.slot);
 const tx=getTransactionDecoder().decode(Buffer.from(result.transaction[0],'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);assert.notEqual(message.version,1);if(message.version===1)throw new Error('Unexpected v1 message');assert.equal(getBase58Decoder().decode(tx.signatures[message.staticAccounts[0]]!),row.signature);
 for(const key of message.staticAccounts.slice(0,message.header.numSignerAccounts))assert.ok(await verifySignature(await getPublicKeyFromAddress(key),tx.signatures[key]!,tx.messageBytes));transactions.set(row.signature,result);
}
const fundingMessage=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(record.funding.wire,'base64')).messageBytes);assert.notEqual(fundingMessage.version,1);if(fundingMessage.version===1)throw new Error('Unsupported funding');assert.equal(fundingMessage.header.numSignerAccounts,2);
const [feePayer,sessionKey]=fundingMessage.staticAccounts,required=decodePaymentRequiredHeader(record.paymentChallenge),accepted=required.accepts[0],endpoint=required.resource.url,intent=job.intents.find(value=>value.id===record.intentId);assert.ok(intent);
const challenge=readStandardChallenge(new Response(null,{status:402,headers:{'payment-required':record.paymentChallenge}}),{protocol:'x402',endpoint,cluster:'localnet',genesis:job.genesis,amount:intent.action.amount,recipient:accepted.payTo,currency:accepted.asset,decimals:6,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'},0);assert.equal(challenge.protocol,'x402');if(challenge.protocol!=='x402')throw new Error('Unsupported challenge');
const rpc=async(method:string,params:unknown[])=>{if(method==='getGenesisHash')return job.genesis;if(method==='getTransaction'){assert.equal((params[1] as any).commitment,'finalized');const value=transactions.get(String(params[0]));assert.ok(value);return value;}throw new Error('Offline verification cannot access RPC.');};
const verified=await verifyPrefundedX402Settlement({job,action:intent.action,intentId:intent.id,sessionKey,fundingFeePayer:feePayer,recipient:accepted.payTo,endpoint,challenge,rpc,fundingSignature:record.funding.signature,settlementSignature:record.payment.signature,partialWire:record.sponsoredPayment.wire,memo:record.sponsoredPayment.memo});
assert.equal(record.execution,verified.scope.execution);await verifyAutonomousTransaction(rpc,record.result.signature,job.program,verified.scope.resultAccounts,verified.scope.resultData(record.content),feePayer,sessionKey);
for(const transaction of [record.funding,record.payment,record.result])assert.equal(transaction.wire,transactions.get(transaction.signature).transaction[0]);
const verification={status:'failed-run-transactions-verified',runRemainsFailed:true,transactions:9,originalFundingSettlementAndResultVerified:true,originalResultSignature:record.result.signature,scope:'Offline verification of captured transaction evidence; does not prove job completion, production deployment, RPC authenticity or real-model quality'};
await writeFile(join(directory,'transaction-verification.json'),JSON.stringify(verification,null,2)+'\n');console.log(JSON.stringify(verification));

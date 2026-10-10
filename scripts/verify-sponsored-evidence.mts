import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getTransactionDecoder,getCompiledTransactionMessageDecoder,getPublicKeyFromAddress,verifySignature,getBase58Decoder } from '@solana/kit';
import { autonomousServiceScope,verifyAutonomousTransaction } from '../apps/runtime/src/autonomous-proof.ts';
import { verifySponsoredSettlement } from '../apps/runtime/src/standard-settlement.ts';
if(process.argv.length!==3)throw new Error('Provide sponsored payment evidence directory.');
const root=resolve(process.argv[2]),report=JSON.parse(await readFile(join(root,'report.json'),'utf8')),original=JSON.parse(await readFile(join(root,'original-partial.json'),'utf8'));
assert.equal(report.status,'passed');assert.equal(report.totalTransactions,7);assert.equal(report.transactions.length,7);
const records=new Map<string,any>();
for(const entry of report.transactions){
 const raw=await readFile(join(root,entry.signature+'.json'),'utf8');assert.equal(createHash('sha256').update(raw).digest('hex'),entry.sha256);
 const rpc=JSON.parse(raw).result;assert.equal(rpc.meta.err,null);assert.ok(rpc.meta.fee<=10000);
 const transaction=getTransactionDecoder().decode(Buffer.from(rpc.transaction[0],'base64')),message=getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
 assert.equal(getBase58Decoder().decode(transaction.signatures[message.staticAccounts[0]]!),entry.signature);
 for(const signer of message.staticAccounts.slice(0,message.header.numSignerAccounts))assert.ok(await verifySignature(await getPublicKeyFromAddress(signer),transaction.signatures[signer]!,transaction.messageBytes));
 records.set(entry.signature,rpc);
}
const rpc=async(method:string,params:unknown[])=>method==='getGenesisHash'?original.job.genesis:records.get(String(params[0]))??null;
await verifySponsoredSettlement({rpc,genesis:original.job.genesis,signature:report.paymentSignature,partialWire:original.partialWire,sponsor:original.sponsor,clientSigners:[original.sessionKey],allowedSponsorAccounts:original.sponsor===original.recipient?[{instruction:0,account:7}]:[]});
const scope=await autonomousServiceScope({job:original.job,action:original.action,intentId:original.intentId,sessionKey:original.sessionKey,feePayer:original.feePayer,rentPayer:original.sessionKey,recipient:original.recipient,endpoint:original.endpoint,memo:original.memo});
await verifyAutonomousTransaction(rpc,report.paymentSignature,original.job.program,scope.accounts,scope.paymentData,original.sponsor,original.sessionKey,scope.extra);
await verifyAutonomousTransaction(rpc,report.resultSignature,original.job.program,scope.resultAccounts,scope.resultData(report.content),original.feePayer,original.sessionKey);
const payment=records.get(report.paymentSignature);assert.equal(payment.meta.preBalances[0]-payment.meta.postBalances[0],payment.meta.fee);
const result={status:'passed',transactionsVerified:7,checks:['saved checksums','all required Ed25519 signatures','sponsor only added its signature','exact canonical USDC payment and memo','exact output commitment','sponsor SOL debit equals network fee'],realModelQuotaUsed:'unchanged'};
await writeFile(join(root,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));

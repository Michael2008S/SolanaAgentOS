import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Decoder,getPublicKeyFromAddress,verifySignature } from '@solana/kit';
import { parseAutonomousJob } from '../apps/runtime/src/autonomous-loop.ts';
if(process.argv.length!==3)throw new Error('Provide the real autonomous evidence directory.');
const root=resolve(process.argv[2]),json=async(name:string)=>JSON.parse(await readFile(join(root,name),'utf8')),hash=(body:string)=>createHash('sha256').update(body).digest('hex');
const report=await json('report.json'),job=parseAutonomousJob(await json('job.json')),sources=await json('sources.json');
assert.ok(['passed','partial'].includes(report.status));assert.equal(report.totalTransactions,2);assert.equal(report.transactions.length,2);assert.equal(report.modelRequestsAfter-report.modelRequestsBefore,3);
assert.equal(job.id,report.jobId);assert.equal(job.agent,report.agent);assert.equal(job.session,report.session);assert.equal(job.genesis,report.genesis);assert.equal(job.state,'completed');assert.equal(job.cycle,2);assert.equal(job.modelRequests,3);assert.equal(job.evaluations.length,2);assert.equal(job.evaluations[0].complete,false);assert.equal(job.evaluations[1].complete,true);assert.equal(job.intents.length,2);assert.deepEqual(job.spent,{sol:'0',usdc:'0'});
for(const [index,topic] of ['accounts','fees'].entries()){
 const intent=job.intents[index];assert.equal(intent.action.tool,'mcp:official:read_'+topic);assert.equal(intent.phase,'complete');assert.equal(intent.action.amount,'0');assert.equal(intent.action.asset,'SOL');assert.ok(intent.receipt);assert.equal(hash(intent.receipt.output),intent.receipt.outputHash);
 const content=JSON.parse(intent.receipt.output).result.content;assert.equal(content.length,1);const source=JSON.parse(content[0].text);assert.equal(source.topic,topic);assert.equal(source.sha256,sources[topic].sha256);assert.equal(source.url,sources[topic].url);assert.equal(source.excerpt,sources[topic].excerpt);
 const raw=await readFile(join(root,topic+'-source.mdx'),'utf8');assert.equal(hash(raw),source.sha256);assert.equal(Buffer.byteLength(raw),source.bytes);assert.equal(source.excerptOnly,true);assert.ok(job.answer!.includes(intent.receipt.id));
}
const allowed=new Set(['initialize_agent','create_session'].map(name=>hash('global:'+name).slice(0,16)));
for(const item of report.transactions){
 const raw=await readFile(join(root,item.signature+'.json'),'utf8');assert.equal(hash(raw),item.sha256);const rpc=JSON.parse(raw).result;assert.equal(rpc.meta.err,null);assert.equal(rpc.meta.fee,5000);
 const tx=getTransactionDecoder().decode(Buffer.from(rpc.transaction[0],'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes),signers=message.staticAccounts.slice(0,message.header.numSignerAccounts);
 assert.equal(getBase58Decoder().decode(tx.signatures[signers[0]]!),item.signature);for(const signer of signers)assert.ok(await verifySignature(await getPublicKeyFromAddress(signer),tx.signatures[signer]!,tx.messageBytes));
 assert.equal(message.instructions.length,1);const ix=message.instructions[0];assert.equal(message.staticAccounts[ix.programAddressIndex],job.program);assert.ok(allowed.delete(Buffer.from(ix.data!).subarray(0,8).toString('hex')));
}
assert.equal(allowed.size,0);assert.equal(report.completedRestartNoReplay,true);assert.equal(report.toolCalls,2);
const coverage=[/lamports[\s\S]{0,200}(balance|SOL|units)/i,/data[\s\S]{0,200}(state|byte|code)/i,/owner[\s\S]{0,200}(program|write)/i,/executable[\s\S]{0,200}(program|code|boolean)/i,/rent_epoch[\s\S]{0,200}(deprecated|legacy|unused)/i];
const completeFieldCoverage=coverage.every(pattern=>pattern.test(job.answer!));
if(report.status==='partial'){assert.equal(completeFieldCoverage,false);assert.equal(report.answerQualityStatus,'incomplete');assert.equal((await json('quality-audit.json')).status,'incomplete');}
else assert.equal(completeFieldCoverage,true,'Self-reported model completion is not sufficient for answer coverage.');
const verification={status:report.status,controlFlowStatus:'passed',answerFieldCoverage:completeFieldCoverage,transactionsVerified:2,realModelRequests:3,cycles:2,checks:['exact original source hashes, receipt hashes and two source attributions','two original setup transactions and every required Ed25519 signature','incomplete first evaluation and completed second evaluation with two distinct tool calls','zero gross tool spend','retained answer and no observed replay after Runtime restart','explicit field-coverage audit independent of model completion status'],limitations:['Source tools were exposed in dependency order to exercise two cycles.','Coverage checks do not prove all claims correct; partial evidence remains partial.','No new paid-tool or public production acceptance.']};
await writeFile(join(root,'verification.json'),JSON.stringify(verification,null,2)+'\n');console.log(JSON.stringify(verification));

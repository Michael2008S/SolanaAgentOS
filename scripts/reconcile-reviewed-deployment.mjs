import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {officialWorkflowUpstream} from './devnet-workflow-funding-rpc.mjs';
import {inspectDeploymentTransaction} from './devnet-deployment-guard.mjs';

const requireThat=(condition,message)=>{if(!condition)throw Error(message);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

// A null transaction alone cannot resolve an original submission. Require the
// complete payer index, expired original blockhashes and exact native accounting.
export function checkDeploymentReconciliation({review,attempts,receipts,history,statuses,expiry,balance}){
 requireThat(review.network==='devnet'&&review.rpc==='https://api.devnet.solana.com'&&review.genesisHash==='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','Official Devnet review required.');
 requireThat(receipts.length>0&&new Set(receipts.map(x=>x.signature)).size===receipts.length,'Unique finalized receipts required.');
 const ordered=[...receipts].sort((a,b)=>a.slot-b.slot),first=ordered[0],known=new Map(receipts.map(x=>[x.signature,x]));
 requireThat(first.phase==='initialize-buffer','The first finalized receipt must anchor the original payer balance.');
 requireThat(history.length===receipts.length-1&&new Set(history.map(x=>x.signature)).size===history.length,'Complete payer signature interval required.');
 for(const row of history){const receipt=known.get(row.signature);requireThat(receipt&&row.signature!==first.signature&&row.slot===receipt.slot&&row.confirmationStatus==='finalized'&&JSON.stringify(row.err)===JSON.stringify(receipt.err),'Payer index contains an unaccounted effect or mismatched receipt.');}
 requireThat(BigInt(first.preBalance)===BigInt(review.currentBalanceLamports),'Original receipt balance differs from deployment review.');
 const net=receipts.reduce((sum,x)=>sum+BigInt(x.preBalance)-BigInt(x.postBalance),0n);
 requireThat(BigInt(balance.value)===BigInt(first.preBalance)-net&&balance.slot>=ordered.at(-1).slot,'Current payer balance does not reconcile all original effects.');
 const missing=attempts.filter(x=>!known.has(x.signature));
 requireThat(statuses.length===missing.length&&expiry.size===new Set(missing.map(x=>x.blockhash)).size,'Every missing original signature and blockhash must be checked.');
 for(let i=0;i<missing.length;i++){const row=missing[i];requireThat(statuses[i]===null,'A missing original transaction has a recorded status; capture it before reconciliation.');const check=expiry.get(row.blockhash);requireThat(check?.value===false&&check.slot>=ordered.at(-1).slot,'Original blockhash remains valid or expiry checkpoint is too old.');}
 return {status:'expired-with-no-finalized-record',finalized:receipts.length,expiredWithoutFinalizedRecord:missing.length,initialPayerLamports:first.preBalance.toString(),currentPayerLamports:BigInt(balance.value).toString(),accountedPayerDebitLamports:net.toString(),firstSlot:first.slot,lastSlot:ordered.at(-1).slot,signatures:missing.map(x=>({signature:x.signature,blockhash:x.blockhash,phase:x.phase,outcome:'expired-with-no-finalized-record'}))};
}

async function main(){
 requireThat(process.argv.length===2&&process.env.AGENTOS_DEPLOYMENT_REVIEW,'Use the saved deployment review with no command overrides.');
 const review=JSON.parse(await readFile(process.env.AGENTOS_DEPLOYMENT_REVIEW,'utf8')),source=review.evidenceDirectory;
 const report=JSON.parse(await readFile(source+'/receipts-report.json','utf8')),journal=(await readFile(source+'/submissions.jsonl','utf8')).trim().split('\n').map(JSON.parse),attempts=journal.filter(x=>x.transactionSha256),binary=await readFile(review.binary);
 requireThat(sha(binary)===review.binarySha256&&attempts.length===report.submittedAttempts&&new Set(attempts.map(x=>x.signature)).size===attempts.length,'Original review, binary or journal differs.');
 const directory=resolve('docs/evidence/devnet-deployment-reconciliation-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory);const files=[];
 const upstream=officialWorkflowUpstream({onResponse:async({method,params,bytes})=>{const file=`rpc-${files.length.toString().padStart(3,'0')}-${method}.json`;await writeFile(directory+'/'+file,bytes,{flag:'wx',mode:0o600});files.push({file,method,params,sha256:sha(bytes)});}});
 const rpc=async(method,params=[])=>{const result=await upstream(method,params);requireThat(!result.error&&Object.hasOwn(result,'result'),'Official read returned an RPC error.');return result.result;};
 const result={format:'agentos-deployment-reconciliation',version:1,checkedAt:new Date().toISOString(),source,status:'incomplete',transactionsSent:0,modelRequests:0,limitations:['Negative outcomes are bounded by the official finalized RPC address history and blockhash checks; they are not successful transaction receipts.','The original receipt collection report is immutable and remains incomplete; this separate reconciliation records additional evidence.','This report does not prove any Devnet business workflow.']};
 try{
  requireThat(await rpc('getGenesisHash')===review.genesisHash,'Genesis mismatch.');const receipts=[];
  for(const row of report.finalized){const bytes=await readFile(`${source}/receipts/${row.signature}.json`),tx=JSON.parse(bytes).result,attempt=attempts.find(x=>x.signature===row.signature);requireThat(sha(bytes)===row.rawSha256&&attempt&&tx?.meta,'Original receipt integrity mismatch.');const checked=await inspectDeploymentTransaction(tx.transaction[0],review,binary,attempt.buffer);requireThat(checked.signature===row.signature&&checked.transactionSha256===attempt.transactionSha256&&checked.transactionSha256===row.transactionSha256&&tx.slot===row.slot&&tx.meta.fee===attempt.feeLamports,'Original wire or fee differs.');receipts.push({signature:row.signature,phase:row.phase,slot:tx.slot,err:tx.meta.err,preBalance:tx.meta.preBalances[0],postBalance:tx.meta.postBalances[0]});}
  const first=[...receipts].sort((a,b)=>a.slot-b.slot)[0],history=[];let before;
  for(let page=0;page<10;page++){const rows=await rpc('getSignaturesForAddress',[review.feePayer,{commitment:'finalized',limit:1000,until:first.signature,...(before?{before}:{})}]);requireThat(Array.isArray(rows)&&rows.length<=1000,'Invalid payer history page.');history.push(...rows);if(rows.length<1000)break;requireThat(page<9,'Payer history exceeds the bounded complete interval.');before=rows.at(-1).signature;}
  const known=new Set(receipts.map(x=>x.signature)),missing=attempts.filter(x=>!known.has(x.signature)),statuses=[],expiry=new Map(),lastSlot=Math.max(...receipts.map(x=>x.slot));
  // Official history reads of many absent signatures can time out. Keep each
  // bounded read small; never retry a send or replace an original signature.
  for(let offset=0;offset<missing.length;offset+=16){const batch=missing.slice(offset,offset+16),page=await rpc('getSignatureStatuses',[batch.map(x=>x.signature),{searchTransactionHistory:true}]);requireThat(page.value?.length===batch.length&&page.context.slot>=lastSlot,'Original signature history checkpoint is invalid.');statuses.push(...page.value);}
  for(const blockhash of new Set(missing.map(x=>x.blockhash))){const value=await rpc('isBlockhashValid',[blockhash,{commitment:'finalized'}]);expiry.set(blockhash,{value:value.value,slot:value.context.slot});}
  const balance=await rpc('getBalance',[review.feePayer,{commitment:'finalized'}]);Object.assign(result,checkDeploymentReconciliation({review,attempts,receipts,history,statuses,expiry,balance:{value:balance.value,slot:balance.context.slot}}),{genesisHash:review.genesisHash,payer:review.feePayer,historyEntries:history.length,historyAnchor:first.signature,originalUnknown:report.unknown.length,originalRpcRejected:report.notAccepted.length});
 }catch{result.error='Original effects could not be fully reconciled; preserve all captures and do not infer missing outcomes.';process.exitCode=1;}
 finally{result.rpcResponses=files;result.endedAt=new Date().toISOString();await writeFile(directory+'/report.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({directory,status:result.status,finalized:result.finalized,expiredWithoutFinalizedRecord:result.expiredWithoutFinalizedRecord,transactionsSent:0}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Read-only deployment reconciliation stopped.');process.exitCode=1;});

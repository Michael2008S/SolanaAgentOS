import {readFile,writeFile,open,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {officialWorkflowUpstream,verifyFundingReview} from './devnet-workflow-funding-rpc.mjs';
import {inspectWorkflowFunding,validateWorkflowFundingRecords} from './devnet-workflow-funding.mjs';
import {inspectWorkflowTransaction,verifyWorkflowReview} from './devnet-workflow-rpc.mjs';
import {parseDeploymentRpc} from './devnet-deployment-guard.mjs';
const check=(condition,message)=>{if(!condition)throw Error(message);},hash=b=>createHash('sha256').update(b).digest('hex');
check(process.argv.length===3,'Provide the original role evidence directory for read-only collection.');
const d=resolve(process.argv[2]),read=async f=>JSON.parse(await readFile(join(d,f),'utf8')),rows=async f=>(await readFile(join(d,f),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const funding=verifyFundingReview(await read('funding/review.json')),business=verifyWorkflowReview(await read('business-review.json')),fundingRows=await rows('funding/funding-submissions.jsonl'),businessRows=await rows('business-submissions.jsonl');
check(funding.recipients.payer===business.feePayer&&funding.fundingWallet===business.fundingWallet,'Original payer differs.');await validateWorkflowFundingRecords(funding,fundingRows);
const originalBytes=new Map(),upstream=officialWorkflowUpstream({onResponse:async({method,params,bytes})=>{if(method==='getTransaction')originalBytes.set(String(params[0]),bytes);}}),report={format:'agentos-devnet-original-role-capture',version:1,checkedAt:new Date().toISOString(),status:'incomplete',scope:'Read-only original transactions after a terminal run; collection cannot prove the business workflow passed.',transactionsSent:0,modelRequests:0,transactions:[],unknown:[]};
check((await upstream('getGenesisHash',[])).result===business.genesisHash,'Official genesis differs.');await mkdir(join(d,'all-transactions'),{recursive:true});
for(const [kind,records] of [['funding',fundingRows],['business',businessRows]])for(const row of records.filter(r=>r.transactionSha256)){
 const proof=kind==='funding'?await inspectWorkflowFunding(row.wire,funding):await inspectWorkflowTransaction(row.wire,business);check(proof.signature===row.signature&&proof.transactionSha256===row.transactionSha256,'Original signed wire differs.');const file=join(d,'all-transactions',row.signature+'.json');let raw;
 try{raw=await readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;const response=await upstream('getTransaction',[row.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:1}]);if(response.error||!response.result){report.unknown.push(row.signature);continue;}raw=originalBytes.get(row.signature);check(raw,'Original RPC bytes missing.');const f=await open(file,'wx',0o600);try{await f.writeFile(raw);await f.sync();}finally{await f.close();}
 }
 const tx=parseDeploymentRpc(raw).result;check(tx?.transaction?.[0]===row.wire&&tx.transaction[1]==='base64'&&tx.meta&&tx.meta.fee===row.feeLamports&&Number.isSafeInteger(tx.slot),'Finalized original wire/fee differs.');report.transactions.push({kind,signature:row.signature,slot:tx.slot,successful:tx.meta.err===null,feeLamports:tx.meta.fee,rawSha256:hash(raw),transactionSha256:row.transactionSha256});
}
report.status=report.unknown.length?'incomplete':'all-observed-originals-captured';report.endedAt=new Date().toISOString();await writeFile(join(d,'terminal-original-transactions.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:report.status,captured:report.transactions.length,unknown:report.unknown.length,transactionsSent:0,modelRequests:0}));

import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,readFile,open,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {address,getTransactionDecoder,getCompiledTransactionMessageDecoder,getPublicKeyFromAddress,verifySignature,getBase58Decoder} from '@solana/kit';
import {officialWorkflowUpstream} from './devnet-workflow-funding-rpc.mjs';
import {parseDeploymentRpc,serializeDeploymentRpc} from './devnet-deployment-guard.mjs';
const requireThat=(condition,message)=>{if(!condition)throw new Error(message);};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',program='HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv',system='11111111111111111111111111111111';
const names=['initialize_agent','create_session','deposit','deposit_usdc','create_task','grant_task_completion','create_task_escrow','create_task_usdc_escrow','grant_worker_delivery','propose_escrow_judge','accept_escrow_judge','register_skill','set_task_status','pay_task_skill','pay_task_usdc_skill','record_task_skill_result','submit_session_escrow_result','record_escrow_judgment','settle_judged_escrow','settle_judged_usdc_escrow','complete_session_task'];
const discriminators=new Map(names.map(name=>[sha256('global:'+name).slice(0,16),name]));
const readMethods=new Set(['getAccountInfo','getBalance','getBlockHeight','getFeeForMessage','getGenesisHash','getHealth','getLatestBlockhash','getMinimumBalanceForRentExemption','getMultipleAccounts','getProgramAccounts','getSignatureStatuses','getSignaturesForAddress','getSlot','getTokenAccountBalance','getTransaction','getVersion','isBlockhashValid','simulateTransaction']);
export function verifyWorkflowReview(review){
 requireThat(review.authorized===true&&review.network==='devnet'&&review.genesisHash===genesis&&review.program===program&&review.rpc==='https://api.devnet.solana.com','An exact authorized official Devnet workflow review is required.');
 requireThat(review.assetMode===undefined||review.assetMode==='SOL','Unknown business asset mode.');
 address(review.feePayer);address(review.fundingWallet);
 requireThat(review.feePayer!==review.fundingWallet&&review.maximumTransactions===50&&review.maximumNetworkFeeLamports===10000,'Use the isolated payer and original transaction/fee caps.');
 const roles=['workerOwner','judgeOwner','provider'];for(const role of roles)address(review.recipients?.[role]);
 requireThat(JSON.stringify(Object.keys(review.recipients).sort())===JSON.stringify([...roles].sort()),'Additional role recipients are forbidden.');
 requireThat(new Set([review.fundingWallet,review.feePayer,...roles.map(role=>review.recipients[role])]).size===5,'Workflow identities must be distinct.');
 return review;
}
/** Only the ephemeral payer can authorize a business wire. Original-wallet
 * funding uses a different server; loader, withdrawals and arbitrary CPI are
 * absent from this fixed acceptance surface. No private keys are loaded. */
export async function inspectWorkflowTransaction(wire,review){
 verifyWorkflowReview(review);requireThat(typeof wire==='string'&&wire.length<=2000,'Workflow wire exceeds its limit.');
 const raw=Buffer.from(wire,'base64');requireThat(raw.length<=1232&&raw.toString('base64')===wire,'Workflow wire encoding differs.');
 const tx=getTransactionDecoder().decode(raw),m=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 requireThat(['legacy',0].includes(m.version)&&!m.addressTableLookups?.length&&m.staticAccounts[0]===review.feePayer&&m.header.numSignerAccounts<=2&&m.header.numReadonlySignerAccounts<m.header.numSignerAccounts&&m.instructions.length===1,'Workflow payer, format or instructions differ.');
 const signers=m.staticAccounts.slice(0,m.header.numSignerAccounts);requireThat(!signers.includes(review.fundingWallet),'The original wallet cannot sign workflow business transactions.');
 for(const key of signers)requireThat(tx.signatures[key]&&await verifySignature(await getPublicKeyFromAddress(address(key)),tx.signatures[key],tx.messageBytes),'Workflow signature is invalid.');
 const ix=m.instructions[0],target=m.staticAccounts[ix.programAddressIndex],data=Buffer.from(ix.data??[]),keys=(ix.accountIndices??[]).map(i=>m.staticAccounts[i]);let action;
 if(target===program){action=discriminators.get(data.subarray(0,8).toString('hex'));requireThat(action&&!(review.assetMode==='SOL'&&action.includes('usdc')),'Unreviewed AgentOS operation.');}
 else{
  const match=Object.entries(review.recipients).find(([,key])=>key===keys[1]);
  requireThat(target===system&&signers.length===1&&keys.length===2&&keys[0]===review.feePayer&&match&&data.length===12&&data.readUInt32LE(0)===2&&data.readBigUInt64LE(4)===(match[0]==='provider'?20000000n:50000000n),'Unreviewed native role funding.');action='fund-'+match[0];
 }
 return {wire,signature:getBase58Decoder().decode(tx.signatures[address(review.feePayer)]),transactionSha256:sha256(raw),messageBase64:Buffer.from(tx.messageBytes).toString('base64'),action};
}

export function workflowSubmissionHandler({review,upstream,journal,records=[]}){
 verifyWorkflowReview(review);const attempts=new Map(),acks=new Map();let totalFees=0;
 const ready=(async()=>{
  for(const row of records.filter(row=>row.transactionSha256)){
   const checked=await inspectWorkflowTransaction(row.wire,review);requireThat(!attempts.has(row.signature)&&(!checked.action.startsWith('fund-')||![...attempts.values()].some(old=>old.action===checked.action))&&checked.signature===row.signature&&checked.transactionSha256===row.transactionSha256&&checked.action===row.action&&Number.isSafeInteger(row.feeLamports)&&row.feeLamports>0&&row.feeLamports<=review.maximumNetworkFeeLamports,'Original business submission differs.');attempts.set(row.signature,row);totalFees+=row.feeLamports;
  }
  for(const row of records.filter(row=>row.response)){requireThat(attempts.has(row.signature)&&!acks.has(row.signature)&&!row.response.error&&row.response.result===row.signature,'Original business acknowledgment differs.');acks.set(row.signature,row.response);}
  requireThat(attempts.size<=review.maximumTransactions&&totalFees<=500000,'Original workflow transaction cap exceeded.');
 })();void ready.catch(()=>{});let tail=ready;
 return params=>{
  const call=tail.then(async()=>{
   await ready;requireThat(params?.[1]?.encoding==='base64','Use base64 workflow transactions.');const checked=await inspectWorkflowTransaction(params[0],review),prior=attempts.get(checked.signature);
   if(prior){requireThat(prior.transactionSha256===checked.transactionSha256,'Original wire changed.');requireThat(acks.has(checked.signature),'Unknown original business send; use read-only reconciliation.');return acks.get(checked.signature);}
   requireThat([...attempts.keys()].every(signature=>acks.has(signature)),'An earlier business send is unknown; no new effect.');
   requireThat(!checked.action.startsWith('fund-')||![...attempts.values()].some(row=>row.action===checked.action),'Original role funding cannot be replaced or repeated.');
   requireThat(attempts.size<review.maximumTransactions,'Workflow transaction cap reached.');
   const network=await upstream('getGenesisHash',[]);requireThat(!network.error&&network.result===genesis,'Workflow genesis differs.');
   const simulation=await upstream('simulateTransaction',[checked.wire,{encoding:'base64',sigVerify:true,commitment:'confirmed'}]);requireThat(!simulation.error&&simulation.result?.value?.err===null,'Workflow simulation failed; no broadcast.');
   const quote=await upstream('getFeeForMessage',[checked.messageBase64,{commitment:'confirmed'}]),fee=quote.result?.value;requireThat(!quote.error&&Number.isSafeInteger(fee)&&fee>0&&fee<=review.maximumNetworkFeeLamports,'Workflow fee exceeds its cap.');
   const row={...checked,feeLamports:fee,reservedAt:new Date().toISOString()};delete row.messageBase64;await journal.writeFile(JSON.stringify(row)+'\n');await journal.sync();attempts.set(row.signature,row);
   const response=await upstream('sendTransaction',[checked.wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}]);requireThat(!response.error&&response.result===checked.signature,'Original business send requires reconciliation.');
   await journal.writeFile(JSON.stringify({signature:checked.signature,response})+'\n');await journal.sync();acks.set(checked.signature,response);return response;
  });tail=call.then(()=>{},()=>{});return call;
 };
}

export function workflowRpcServer({review,upstream,journal,records=[],port=18895}){
 const submit=workflowSubmissionHandler({review,upstream,journal,records});
 const server=createServer(async(req,res)=>{let input;try{
  requireThat(req.method==='POST'&&req.url==='/'&&req.headers.host===`127.0.0.1:${server.address()?.port??port}`&&!req.headers.origin&&!req.headers['content-encoding'],'Expected protected loopback workflow RPC.');const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;requireThat(size<=65536,'Workflow RPC request exceeds limit.');chunks.push(chunk);}
  input=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));requireThat(input&&!Array.isArray(input)&&input.jsonrpc==='2.0'&&Number.isSafeInteger(input.id)&&Array.isArray(input.params??[])&&(input.method==='sendTransaction'||readMethods.has(input.method)),'Unreviewed workflow RPC method.');
  const result=input.method==='sendTransaction'?await submit(input.params):await upstream(input.method,input.params??[]);res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(serializeDeploymentRpc({...result,jsonrpc:'2.0',id:input.id}));
 }catch{res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:Number.isSafeInteger(input?.id)?input.id:null,error:{code:-32002,message:'Workflow RPC rejected; preserve the original signed wire and journal.'}}));}});
 server.requestTimeout=30000;server.headersTimeout=10000;server.maxConnections=64;return server;
}

async function main(){
 requireThat(process.argv.length===3&&process.argv[2]==='--serve'&&process.env.AGENTOS_DEVNET_WORKFLOW_REVIEW,'Use --serve with a saved AGENTOS_DEVNET_WORKFLOW_REVIEW.');const path=process.env.AGENTOS_DEVNET_WORKFLOW_REVIEW;requireThat((await stat(path)).size<=65536,'Workflow review exceeds limit.');
 const review=verifyWorkflowReview(JSON.parse(await readFile(path,'utf8')));requireThat(typeof review.evidenceDirectory==='string'&&review.evidenceDirectory.length>0,'Workflow evidence directory is required.');
 const directory=resolve(review.evidenceDirectory),file=resolve(directory,'business-submissions.jsonl');await mkdir(resolve(directory,'all-transactions'),{recursive:true,mode:0o700});let records=[];
 try{requireThat((await stat(file)).size<=1000000,'Workflow journal exceeds limit.');records=(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
 const upstream=officialWorkflowUpstream({onResponse:async({method,params,bytes})=>{
  if(method!=='getTransaction'||params[1]?.commitment!=='finalized')return;const signature=String(params[0]);requireThat(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature),'Invalid transaction evidence identity.');const payload=parseDeploymentRpc(bytes);if(!payload.result)return;
  try{const proof=await open(resolve(directory,'all-transactions',signature+'.json'),'wx',0o600);try{await proof.writeFile(bytes);await proof.sync();}finally{await proof.close();}}catch(error){if(error.code!=='EEXIST')throw error;}
 }});
 requireThat((await upstream('getGenesisHash',[])).result===genesis,'Official workflow genesis differs.');const journal=await open(file,'a',0o600),server=workflowRpcServer({review,upstream,journal,records});
 const stop=()=>{server.closeAllConnections();server.close(()=>{void journal.close();});};process.once('SIGTERM',stop);process.once('SIGINT',stop);server.on('error',()=>{void journal.close();process.exitCode=1;});
 server.listen(18895,'127.0.0.1',()=>console.log(JSON.stringify({phase:'workflow-guard-ready',rpc:'http://127.0.0.1:18895',feePayer:review.feePayer,maximumTransactions:50})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Workflow guard stopped; inspect its original public scope and journal.');process.exitCode=1;});

import {createServer} from 'node:http';
import {readFile,open,mkdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {address,getAddressEncoder} from '@solana/kit';
import {workflowFundingHandler,workflowTokenAddress,workflowUsdcMint,validateWorkflowFundingRecords} from './devnet-workflow-funding.mjs';
import {parseDeploymentRpc,serializeDeploymentRpc} from './devnet-deployment-guard.mjs';

const token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const requireThat=(condition,message)=>{if(!condition)throw new Error(message);};
const readMethods=new Set(['getAccountInfo','getBalance','getBlockHeight','getClusterNodes','getEpochInfo','getEpochSchedule','getFeeForMessage','getGenesisHash','getHealth','getLatestBlockhash','getMinimumBalanceForRentExemption','getMultipleAccounts','getSignatureStatuses','getSlot','getTokenAccountBalance','getTokenAccountsByOwner','getTokenSupply','getTransaction','getVersion','isBlockhashValid','simulateTransaction']);

export function verifyFundingReview(review,{requireAuthorization=true}={}){
 requireThat((requireAuthorization?review.authorized===true:typeof review.authorized==='boolean')&&review.network==='devnet'&&review.rpc==='https://api.devnet.solana.com'&&review.genesisHash==='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','An authorized official Devnet funding review is required.');
 for(const value of [review.fundingWallet,review.recipients?.payer,review.recipients?.workerOwner])address(value);
 requireThat(new Set([review.fundingWallet,review.recipients.payer,review.recipients.workerOwner]).size===3,'Funding identities must be distinct.');
 requireThat(review.assetMode===undefined||review.assetMode==='SOL','Unknown funding asset mode.');const solOnly=review.assetMode==='SOL';
 requireThat(review.amounts?.payerSolLamports==='300000000'&&review.amounts?.payerUsdcAtomic===(solOnly?'0':'10000')&&review.amounts?.workerOwnerUsdcAtomic===(solOnly?'0':'200000'),'Funding must use the exact isolated workflow amounts.');
 requireThat(review.limits?.maximumWalletLamports===(solOnly?'300010000':'305000000')&&review.limits?.maximumAtaRentLamports===(solOnly?'0':'2100000')&&review.limits?.networkFeePerTransactionLamports==='10000','Funding must retain the exact wallet, rent and fee caps.');
 return review;
}

export function workflowFundingCliSteps(review){
 verifyFundingReview(review);const common=['--url','http://127.0.0.1:18894','--output','json'];
 return [{phase:'payer-SOL',command:'solana',args:['transfer',review.recipients.payer,'0.3','--allow-unfunded-recipient','--with-compute-unit-price','0','--commitment','confirmed',...common]},
  ...(review.assetMode==='SOL'?[]:[['payer','0.01'],['workerOwner','0.2']]).map(([role,amount])=>({phase:role+'-USDC',command:'spl-token',args:['transfer',workflowUsdcMint,amount,review.recipients[role],'--program-id',token,'--fund-recipient','--allow-unfunded-recipient','--with-compute-unit-price','0','--with-compute-unit-limit','200000',...common]}))];
}

/** Fail before any wallet transfer when the official mint or source funds are
 * missing. Never mint substitute tokens or request an airdrop. */
export async function workflowFundingPreflight({review,upstream,records=[]}){
 verifyFundingReview(review,{requireAuthorization:false});
 requireThat(review.authorized||records.length===0,'Unapproved preflight cannot claim existing funding.');
 const history=await validateWorkflowFundingRecords(review,records),acknowledged=phase=>{const record=history.phases.get(phase);return !!record&&history.responses.has(record.signature);};
 const genesis=await upstream('getGenesisHash',[]);requireThat(!genesis.error&&genesis.result===review.genesisHash,'Funding preflight genesis differs.');
 if(review.assetMode==='SOL'){
  const native=await upstream('getBalance',[review.fundingWallet,{commitment:'finalized'}]);requireThat(!native.error&&native.result&&(typeof native.result.value==='bigint'||Number.isSafeInteger(native.result.value))&&native.result.value>=0,'Funding SOL balance read failed.');
  const required=BigInt(review.limits.maximumWalletLamports)-history.fees-history.debits,unknown=[...history.phases.values()].some(row=>!history.responses.has(row.signature)),available=BigInt(native.result.value);
  return {format:'agentos-devnet-workflow-funding-preflight',version:1,checkedAt:new Date().toISOString(),network:'devnet',assetMode:'SOL',genesisHash:review.genesisHash,slot:native.result.context.slot,fundingWallet:review.fundingWallet,availableSolLamports:available.toString(),requiredSolLamports:required.toString(),authorized:review.authorized,originalEffectUnknown:unknown,fundsAvailable:available>=required,ready:review.authorized&&!unknown&&available>=required,transactionsSent:0};
 }
 const ata=await workflowTokenAddress(review.fundingWallet);
 const result=await upstream('getMultipleAccounts',[[workflowUsdcMint,ata],{encoding:'base64',commitment:'finalized'}]);
 requireThat(!result.error&&result.result?.value?.length===2,'Funding account reads failed.');
 const [mint,account]=result.result.value;
 requireThat(mint&&mint.owner===token&&!mint.executable&&mint.data?.[1]==='base64','Official USDC mint is absent or invalid.');
 const mintBytes=Buffer.from(mint.data[0],'base64');requireThat(mintBytes.length===82&&mintBytes[44]===6&&mintBytes[45]===1,'Official USDC mint layout or decimals differ.');
 let amount=0n;
 if(account){
  requireThat(account.owner===token&&!account.executable&&account.data?.[1]==='base64','Funding USDC account owner or encoding differs.');
  const bytes=Buffer.from(account.data[0],'base64'),encoder=getAddressEncoder();
  requireThat(bytes.length===165&&bytes.subarray(0,32).equals(Buffer.from(encoder.encode(address(workflowUsdcMint))))&&bytes.subarray(32,64).equals(Buffer.from(encoder.encode(address(review.fundingWallet))))&&bytes[108]===1,'Funding USDC account mint, authority or state differs.');
  amount=bytes.readBigUInt64LE(64);
 }
 const native=await upstream('getBalance',[review.fundingWallet,{commitment:'finalized'}]);
 requireThat(!native.error&&native.result&&(typeof native.result.value==='bigint'||Number.isSafeInteger(native.result.value))&&native.result.value>=0,'Funding SOL balance read failed.');
 const sol=BigInt(native.result.value),requiredUsdc=(acknowledged('payer-USDC')?0n:BigInt(review.amounts.payerUsdcAtomic))+(acknowledged('workerOwner-USDC')?0n:BigInt(review.amounts.workerOwnerUsdcAtomic)),requiredSol=BigInt(review.limits.maximumWalletLamports)-history.fees-history.debits;
 const originalEffectUnknown=[...history.phases.values()].some(row=>!history.responses.has(row.signature));
 return {format:'agentos-devnet-workflow-funding-preflight',version:1,checkedAt:new Date().toISOString(),network:'devnet',genesisHash:review.genesisHash,slot:result.result.context.slot,fundingWallet:review.fundingWallet,usdcMint:workflowUsdcMint,sourceAta:ata,sourceAtaPresent:!!account,availableUsdcAtomic:amount.toString(),requiredUsdcAtomic:requiredUsdc.toString(),availableSolLamports:sol.toString(),requiredSolLamports:requiredSol.toString(),authorized:review.authorized,originalEffectUnknown,fundsAvailable:amount>=requiredUsdc&&sol>=requiredSol,ready:review.authorized&&!originalEffectUnknown&&amount>=requiredUsdc&&sol>=requiredSol,transactionsSent:0};
}

/** All writes go through the original exact funding inspector. This server is
 * not a business-transaction relay and cannot accept role or loader writes. */
export function workflowFundingServer({review,upstream,journal,records=[],port=18894}){
 verifyFundingReview(review);
 const submit=workflowFundingHandler({review,upstream,journal,records});
 const server=createServer(async(req,res)=>{
  let input;
  try{
   const hostPort=server.address()?.port??port;
   requireThat(req.method==='POST'&&req.url==='/'&&req.headers.host===`127.0.0.1:${hostPort}`&&!req.headers.origin&&!req.headers['content-encoding'],'Expected local CLI RPC request.');
   const parts=[];let size=0;
   for await(const part of req){size+=part.length;requireThat(size<=65536,'Funding RPC request exceeds 64 KiB.');parts.push(part);}
   input=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(parts)));
   requireThat(input&&!Array.isArray(input)&&input.jsonrpc==='2.0'&&(typeof input.id==='number'&&Number.isSafeInteger(input.id)||typeof input.id==='string'&&input.id.length<=80)&&Array.isArray(input.params??[]),'Invalid RPC request.');
   requireThat(input.method==='sendTransaction'||readMethods.has(input.method),'Funding RPC method is not allowed.');
   const output=input.method==='sendTransaction'?await submit(input.params):await upstream(input.method,input.params??[]);
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(serializeDeploymentRpc({...output,jsonrpc:'2.0',id:input.id}));
  }catch{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({jsonrpc:'2.0',id:typeof input?.id==='number'&&Number.isSafeInteger(input.id)?input.id:null,error:{code:-32002,message:'Funding request rejected; preserve original scope and inspect the public journal.'}}));}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;server.maxConnections=8;
 return server;
}

export function officialWorkflowUpstream({onResponse,transport=fetch}={}){
 let nextAt=0,id=0,active=0;const waiters=[];
 const acquire=async()=>{if(active<4){active++;return;}await new Promise(done=>waiters.push(done));};
 const release=()=>{const next=waiters.shift();if(next)next();else active--;};
 return (method,params=[])=>{
  const run=(async()=>{await acquire();try{
   // A send is dispatched once. Unknown transport cannot trigger an automatic
   // retry; the funding journal already holds its exact public signed wire.
   const attempts=method==='sendTransaction'?1:4;
   for(let n=0;n<attempts;n++){
    const start=Math.max(Date.now(),nextAt);nextAt=start+350;await new Promise(done=>setTimeout(done,Math.max(0,start-Date.now())));
    let response;
    try{response=await transport('https://api.devnet.solana.com',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:serializeDeploymentRpc({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(20000)});}catch{requireThat(n+1<attempts,'Official Devnet transport unavailable.');nextAt=Math.max(nextAt,Date.now()+2000*(n+1));continue;}
    if(response.status===429&&n+1<attempts){await response.body?.cancel();nextAt=Math.max(nextAt,Date.now()+10000*(n+1));continue;}
    requireThat(response.ok&&response.body,'Official Devnet RPC unavailable.');
    const reader=response.body.getReader(),parts=[];let size=0;
    try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;requireThat(size<=5000000,'Official Devnet response exceeds 5 MB.');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const bytes=Buffer.concat(parts);if(onResponse)await onResponse({method,params,bytes});
    return parseDeploymentRpc(new TextDecoder('utf8',{fatal:true}).decode(bytes));
   }
  }finally{release();}})();return run;
 };
}

async function main(){
 requireThat(process.argv.length===3&&['--preflight','--serve'].includes(process.argv[2]),'Use --preflight or --serve with AGENTOS_WORKFLOW_FUNDING_REVIEW.');
 const reviewPath=process.env.AGENTOS_WORKFLOW_FUNDING_REVIEW;requireThat(reviewPath,'A saved exact funding review is required.');
 requireThat((await stat(reviewPath)).size<=65536,'Funding review exceeds 64 KiB.');
 const review=verifyFundingReview(JSON.parse(await readFile(reviewPath,'utf8')),{requireAuthorization:process.argv[2]==='--serve'}),upstream=officialWorkflowUpstream();
 requireThat(typeof review.evidenceDirectory==='string'&&review.evidenceDirectory.length>0,'Funding evidence directory is required.');
 const file=resolve(review.evidenceDirectory,'funding-submissions.jsonl');let records=[];
 try{requireThat((await stat(file)).size<=1000000,'Funding journal exceeds 1 MB.');records=(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
 const result=await workflowFundingPreflight({review,upstream,records});
 await mkdir(review.evidenceDirectory,{recursive:true,mode:0o700});
 const proof=await open(resolve(review.evidenceDirectory,`preflight-${result.checkedAt.replace(/[:.]/g,'-')}.json`),'wx',0o600);
 try{await proof.writeFile(JSON.stringify(result,null,2)+'\n');await proof.sync();}finally{await proof.close();}
 console.log(JSON.stringify(result));
 if(process.argv[2]==='--preflight'){if(!result.ready)process.exitCode=2;return;}
 requireThat(result.ready,'Workflow funding requires the real official Devnet USDC and SOL balances. No server or transfer started.');
 const journal=await open(file,'a',0o600),server=workflowFundingServer({review,upstream,journal,records});
 server.on('error',()=>{void journal.close();process.exitCode=1;});
 const stop=()=>{server.closeAllConnections();server.close(()=>{void journal.close();});};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 server.listen(18894,'127.0.0.1',()=>console.log(JSON.stringify({phase:'funding-guard-ready',rpc:'http://127.0.0.1:18894',transactionsSent:0})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Funding guard stopped; inspect the saved preflight and original public journal.');process.exitCode=1;});

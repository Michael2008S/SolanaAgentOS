import {createHash} from 'node:crypto';
import {address,getAddressEncoder,getProgramDerivedAddress,getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Decoder,getPublicKeyFromAddress,verifySignature} from '@solana/kit';
const system='11111111111111111111111111111111',token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',associated='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',compute='ComputeBudget111111111111111111111111111111';
export const workflowUsdcMint='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const requireThat=(condition,message)=>{if(!condition)throw new Error(message);};
export async function workflowTokenAddress(owner){const enc=getAddressEncoder();return String((await getProgramDerivedAddress({programAddress:address(associated),seeds:[enc.encode(address(owner)),enc.encode(address(token)),enc.encode(address(workflowUsdcMint))]}))[0]);}
/** Original wallet funding only: one exact SOL transfer and two exact USDC
 * transfers to the isolated role addresses. No key material is read here. */
export async function inspectWorkflowFunding(encoded,review){
 requireThat(review.authorized===true&&review.network==='devnet'&&review.genesisHash==='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'&&review.rpc==='https://api.devnet.solana.com','Funding requires the fixed official Devnet scope.');
 requireThat(typeof encoded==='string'&&encoded.length<=2000,'Invalid funding wire.');const raw=Buffer.from(encoded,'base64');requireThat(raw.length<=1232&&raw.toString('base64')===encoded,'Funding encoding differs.');
 const tx=getTransactionDecoder().decode(raw),m=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 requireThat(['legacy',0].includes(m.version)&&!(m.addressTableLookups?.length)&&m.staticAccounts[0]===review.fundingWallet&&m.header.numSignerAccounts===1&&m.header.numReadonlySignerAccounts===0&&m.instructions.length>=1&&m.instructions.length<=4,'Funding signer, version or instruction scope changed.');
 const sig=tx.signatures[address(review.fundingWallet)];requireThat(sig&&await verifySignature(await getPublicKeyFromAddress(address(review.fundingWallet)),sig,tx.messageBytes),'Funding signature is invalid.');
 const solOnly=review.assetMode==='SOL',source=solOnly?null:await workflowTokenAddress(review.fundingWallet),destinations=solOnly?[]:await Promise.all(['payer','workerOwner'].map(async role=>({role,owner:review.recipients[role],ata:await workflowTokenAddress(review.recipients[role]),amount:BigInt(review.amounts[role+'UsdcAtomic'])})));
 let phase='',rent=0n,sol=0n,ataDestination;
 for(const ix of m.instructions){const p=m.staticAccounts[ix.programAddressIndex],keys=(ix.accountIndices??[]).map(i=>m.staticAccounts[i]),data=Buffer.from(ix.data??[]);
  if(p===compute){requireThat(keys.length===0&&(data.length===5&&data[0]===2&&data.readUInt32LE(1)<=1400000||data.length===9&&data[0]===3&&data.readBigUInt64LE(1)===0n),'Unreviewed compute fee.');continue;}
  if(p===associated){const match=destinations.find(d=>keys[1]===d.ata&&keys[2]===d.owner);requireThat(!ataDestination&&match&&keys.length===6&&keys[0]===review.fundingWallet&&keys[3]===workflowUsdcMint&&keys[4]===system&&keys[5]===token&&(data.length===0||data.length===1&&data[0]<=1),'Unreviewed token-account funding.');ataDestination=match.role;rent=BigInt(review.limits.maximumAtaRentLamports);continue;}
  requireThat(!phase,'Multiple funding transfers are forbidden.');
  if(p===system){requireThat(data.length===12&&data.readUInt32LE(0)===2&&data.readBigUInt64LE(4)===BigInt(review.amounts.payerSolLamports)&&keys.length===2&&keys[0]===review.fundingWallet&&keys[1]===review.recipients.payer,'SOL funding amount or recipient changed.');phase='payer-SOL';sol=data.readBigUInt64LE(4);}
  else{const match=destinations.find(d=>keys[2]===d.ata);requireThat(p===token&&match&&data.length===10&&data[0]===12&&data[9]===6&&data.readBigUInt64LE(1)===match.amount&&keys.length===4&&keys[0]===source&&keys[1]===workflowUsdcMint&&keys[3]===review.fundingWallet,'USDC funding scope changed.');phase=match.role+'-USDC';}
 }
 requireThat(phase&&(!ataDestination||phase===ataDestination+'-USDC'),'Missing transfer or mismatched token-account creation.');
 return {phase,signature:getBase58Decoder().decode(sig),wire:encoded,messageBase64:Buffer.from(tx.messageBytes).toString('base64'),transactionSha256:createHash('sha256').update(raw).digest('hex'),reservedWalletLamports:(sol+rent).toString()};
}
export async function validateWorkflowFundingRecords(review,records){
 let fees=0n,debits=0n;const phases=new Map(),responses=new Map();
 for(const r of records.filter(r=>r.transactionSha256)){const checked=await inspectWorkflowFunding(r.wire,review);requireThat(!phases.has(r.phase)&&checked.phase===r.phase&&checked.signature===r.signature&&checked.transactionSha256===r.transactionSha256&&checked.reservedWalletLamports===r.reservedWalletLamports&&Number.isSafeInteger(r.feeLamports)&&r.feeLamports>0&&r.feeLamports<=Number(review.limits.networkFeePerTransactionLamports),'Previous funding scope or fee differs.');phases.set(r.phase,r);fees+=BigInt(r.feeLamports);debits+=BigInt(r.reservedWalletLamports);}
 for(const r of records.filter(r=>r.response)){requireThat([...phases.values()].some(p=>p.signature===r.signature)&&!responses.has(r.signature)&&!r.response.error&&r.response.result===r.signature,'Previous funding acknowledgment differs.');responses.set(r.signature,r.response);}
 requireThat(phases.size<=(review.assetMode==='SOL'?1:3)&&fees+debits<=BigInt(review.limits.maximumWalletLamports),'Previous funding exceeds wallet cap.');return {fees,debits,phases,responses};
}
/** Reserve each original phase durably before broadcast; unknown effects block
 * replacement wires, including a new blockhash for the same recipient. */
export function workflowFundingHandler({review,upstream,journal,records=[]}){
 let fees=0n,debits=0n,phases=new Map(),responses=new Map();
 const ready=validateWorkflowFundingRecords(review,records).then(history=>{({fees,debits,phases,responses}=history);});let tail=ready;
 // Keep invalid history rejected for every request without an unhandled
 // rejection while a newly opened HTTP server waits for its first request.
 void ready.catch(()=>{});
 return params=>{const pending=tail.then(async()=>{await ready;
  requireThat(params?.[1]?.encoding==='base64','Use base64 funding.');const checked=await inspectWorkflowFunding(params[0],review),prior=phases.get(checked.phase);
  if(prior){requireThat(prior.signature===checked.signature,'Original funding phase cannot be replaced or replayed.');const response=responses.get(prior.signature);requireThat(response&&!response.error&&response.result===prior.signature,'Original funding requires reconciliation; no replay.');return response;}
  requireThat([...phases.values()].every(r=>{const response=responses.get(r.signature);return response&&!response.error&&response.result===r.signature;}),'An earlier funding effect is unknown; reconcile it before any further funding.');
  requireThat(phases.size<(review.assetMode==='SOL'?1:3),'Funding transaction cap reached.');const network=await upstream('getGenesisHash',[]);requireThat(network.result===review.genesisHash&&!network.error,'Funding genesis changed.');
  const sim=await upstream('simulateTransaction',[checked.wire,{encoding:'base64',sigVerify:true,commitment:'confirmed'}]);requireThat(!sim.error&&sim.result?.value?.err===null,'Funding simulation failed; no send.');
  const quote=await upstream('getFeeForMessage',[checked.messageBase64,{commitment:'confirmed'}]),fee=quote.result?.value;
  requireThat(!quote.error&&Number.isSafeInteger(fee)&&fee>0&&fee<=Number(review.limits.networkFeePerTransactionLamports),'Funding fee exceeds review.');
  requireThat(debits+fees+BigInt(fee)+BigInt(checked.reservedWalletLamports)<=BigInt(review.limits.maximumWalletLamports),'Funding wallet cap exceeded.');
  const record={...checked,feeLamports:fee,reservedAt:new Date().toISOString()};delete record.messageBase64;
  await journal.writeFile(JSON.stringify(record)+'\n');await journal.sync();phases.set(checked.phase,record);fees+=BigInt(fee);debits+=BigInt(checked.reservedWalletLamports);
  const response=await upstream('sendTransaction',[checked.wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}]);
  requireThat(!response.error&&response.result===checked.signature,'Funding response requires reconciliation.');await journal.writeFile(JSON.stringify({signature:checked.signature,response})+'\n');await journal.sync();responses.set(checked.signature,response);return response;
 });tail=pending.then(()=>{},()=>{});return pending;};
}

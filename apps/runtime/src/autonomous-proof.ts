import { createHash } from 'node:crypto';
import { address, getAddressEncoder, getBase58Decoder, getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress, getTransactionDecoder, getPublicKeyFromAddress, verifySignature } from '@solana/kit';
import type { AutonomousAction, AutonomousJob, AutonomousReceipt } from './autonomous-loop.js';
import type { GatewayOutput } from './autonomous-gateway.js';
import { rememberVerifiedExecution } from './memory.js';
import { readStandardChallenge } from './standard-payments.js';
import { standardToolTerms,type StandardTool } from './standard-tools.js';
import { runtimeNetwork } from './chain-network.js';
import { verifySponsoredSettlement } from './standard-settlement.js';

type Rpc = (method: string, params: unknown[]) => Promise<any>;
const digest=(value:string)=>createHash('sha256').update(value).digest();
const disc=(name:string)=>digest('global:'+name).subarray(0,8);
const u64=(value:bigint)=>{const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(value);return bytes;};
const system='11111111111111111111111111111111';
const token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ata='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const mint='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const encode=(value:string)=>Buffer.from(getAddressEncoder().encode(address(value)));
const pda=async(program:string,seeds:readonly Uint8Array[])=>String((await getProgramDerivedAddress({programAddress:address(program),seeds:[...seeds]}))[0]);
export const autonomousExecutionId=(job:AutonomousJob,intentId:string)=>{
  const bound=job.intents.find(intent=>intent.id===intentId)?.executionId;
  if(bound===undefined)throw new Error('Intent has no durable chain execution allocation.');
  return BigInt(bound);
};

/** Strict receipt mode: exact known instructions, no ALTs or unknown extras.
 * A service assertion or verified:true field is never accepted as chain proof. */
export async function verifyAutonomousTransaction(rpc:Rpc,signature:string,program:string,accounts:string[],data:Uint8Array,feePayer:string,sessionKey:string,extra:readonly {program:string;accounts:string[];data:Uint8Array}[]=[]){
  const result=await rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
  if(!result||result.meta?.err!==null||!Number.isSafeInteger(result.meta.fee)||result.meta.fee<0||result.meta.fee>10000
    ||!Array.isArray(result.transaction)||result.transaction[1]!=='base64'||typeof result.transaction[0]!=='string'||result.transaction[0].length>2000)
    throw new Error('Original finalized transaction is missing, failed or outside the fee cap.');
  const tx=getTransactionDecoder().decode(Buffer.from(result.transaction[0],'base64'));
  const message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if(message.version===1)throw new Error('This receipt mode currently requires the existing legacy/v0 transaction format.');
  const signatures=Object.entries(tx.signatures);
  if(!signatures[0]?.[1]||getBase58Decoder().decode(signatures[0][1])!==signature||message.staticAccounts[0]!==feePayer
    ||'addressTableLookups' in message&&(message.addressTableLookups?.length??0)>0||message.instructions.length!==1+extra.length)
    throw new Error('Transaction does not match the fixed execution scope.');
  const signers=message.staticAccounts.slice(0,message.header.numSignerAccounts);
  if(new Set(signers).size!==new Set([sessionKey,feePayer]).size||![sessionKey,feePayer].every(key=>signers.includes(address(key))))
    throw new Error('Transaction has an unauthorized signer.');
  for(const key of signers){const signatureBytes=tx.signatures[key];if(!signatureBytes||!await verifySignature(await getPublicKeyFromAddress(key),signatureBytes,tx.messageBytes))
    throw new Error('Transaction signature is invalid.');}
  const expected=[{program,accounts,data},...extra];
  for(const [index,scope] of expected.entries()){
   const instruction=message.instructions[index];
   if(message.staticAccounts[instruction.programAddressIndex]!==scope.program||!Buffer.from(instruction.data??[]).equals(Buffer.from(scope.data))
     ||JSON.stringify((instruction.accountIndices??[]).map(index=>message.staticAccounts[index]))!==JSON.stringify(scope.accounts))throw new Error('Transaction instruction differs from the authorized action.');
  }
  if(message.staticAccounts.some(key=>key!==feePayer&&!expected.some(scope=>scope.program===key||scope.accounts.includes(key))))throw new Error('Transaction contains an unauthorized account.');
  return result;
}

export async function autonomousServiceScope(input:{job:AutonomousJob;action:AutonomousAction;intentId:string;sessionKey:string;feePayer:string;recipient:string;endpoint:string;memo?:string;rentPayer?:string}){
 const {job,action,intentId,sessionKey,feePayer,recipient}=input,id=autonomousExecutionId(job,intentId);
 const execution=await pda(job.program,[Buffer.from('execution'),encode(job.agent),u64(id)]),policy=await pda(job.program,[Buffer.from('policy'),encode(job.agent)]);
 const inputHash=digest(JSON.stringify({tool:action.tool,endpoint:input.endpoint,prompt:action.input}));
 let accounts:string[];
 if(action.asset==='SOL')accounts=[sessionKey,input.rentPayer??feePayer,job.agent,policy,job.session,await pda(job.program,[Buffer.from('vault'),encode(job.agent)]),recipient,execution,system];
 else{const tokenAddress=(owner:string)=>pda(ata,[encode(owner),encode(token),encode(mint)]);
  accounts=[sessionKey,input.rentPayer??feePayer,job.agent,policy,job.session,mint,await tokenAddress(job.agent),recipient,await tokenAddress(recipient),execution,token,ata,system];}
 const extra=input.memo===undefined?[]:[{program:'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',accounts:[sessionKey],data:Buffer.from(input.memo)}];
 return {execution,inputHash,accounts,extra,paymentData:Buffer.concat([disc(action.asset==='SOL'?'pay_service':'pay_usdc_service'),u64(BigInt(action.amount)),inputHash,Buffer.alloc(32),u64(id)]),
  resultAccounts:[sessionKey,feePayer,job.agent,job.session,execution],resultData:(content:string)=>Buffer.concat([disc('record_skill_result'),digest(content)])};
}

export async function autonomousSkillScope(input:{job:AutonomousJob;action:AutonomousAction;intentId:string;
  sessionKey:string;feePayer:string;provider:string}){
  const {job,action,intentId,sessionKey,feePayer,provider}=input;
  const id=autonomousExecutionId(job,intentId);
  const execution=await pda(job.program,[Buffer.from('execution'),encode(job.agent),u64(id)]);
  const inputHash=digest(JSON.stringify({skill:action.tool,prompt:action.input}));
  const policy=await pda(job.program,[Buffer.from('policy'),encode(job.agent)]);
  let accounts:string[];
  if(action.asset==='SOL')accounts=[sessionKey,feePayer,job.agent,policy,job.session,
    await pda(job.program,[Buffer.from('vault'),encode(job.agent)]),action.tool,provider,execution,system];
  else{
    const tokenAddress=(owner:string)=>pda(ata,[encode(owner),encode(token),encode(mint)]);
    accounts=[sessionKey,feePayer,job.agent,policy,job.session,mint,await tokenAddress(job.agent),action.tool,provider,
      await tokenAddress(provider),execution,token,ata,system];
  }
  return {execution,inputHash,accounts,paymentData:Buffer.concat([disc(action.asset==='SOL'?'pay_skill':'pay_usdc_skill'),u64(BigInt(action.amount)),inputHash,u64(id)]),
    resultAccounts:[sessionKey,feePayer,job.agent,job.session,execution],resultData:(content:string)=>Buffer.concat([disc('record_skill_result'),digest(content)])};
}

export async function verifyAutonomousSkillOutput(input:{job:AutonomousJob;action:AutonomousAction;intentId:string;value:GatewayOutput;
  sessionKey:string;feePayer:string;provider:string;rpc:Rpc}):Promise<AutonomousReceipt>{
  const {job,intentId,value,sessionKey,feePayer,rpc}=input;
  const scope=await autonomousSkillScope(input);
  if(value.execution!==scope.execution||value.intentId!==intentId)throw new Error('Result is not the canonical execution for this intent.');
  const outputHash=digest(value.content);
  await verifyAutonomousTransaction(rpc,value.paymentSignature,job.program,scope.accounts,scope.paymentData,feePayer,sessionKey);
  await verifyAutonomousTransaction(rpc,value.resultSignature,job.program,scope.resultAccounts,scope.resultData(value.content),feePayer,sessionKey);
  // This additionally validates the current canonical Execution account and its
  // completed output commitment, instead of relying on transaction text alone.
  const memory=await rememberVerifiedExecution({agent:job.agent,execution:scope.execution,title:'Autonomous '+input.action.tool,content:value.content,tags:['autonomous',job.id]});
  if(memory.source!=='skill'||memory.contentHash!==outputHash.toString('hex'))throw new Error('Execution output commitment differs.');
  return {id:scope.execution,output:value.content,outputHash:memory.contentHash,verified:true};
}

export async function verifyAutonomousServicePayment(input:{job:AutonomousJob;action:AutonomousAction;intentId:string;value:Omit<GatewayOutput,'resultSignature'|'content'>;
 sessionKey:string;feePayer:string;tool:StandardTool;rpc:Rpc}){
 const {job,action,intentId,value,sessionKey,feePayer,tool,rpc}=input;
 if(tool.id!==action.tool||tool.asset!==action.asset||tool.amount!==action.amount||!value.paymentChallenge)throw new Error('Original paid HTTP scope differs from its fixed configuration.');
 const challenge=readStandardChallenge(new Response(null,{status:402,headers:{[tool.protocol==='mpp'?'www-authenticate':'payment-required']:value.paymentChallenge}}),standardToolTerms(tool,runtimeNetwork().cluster,job.genesis),0);
 // Historical successful effects remain verifiable after challenge expiry.
 const sponsored=challenge.protocol==='x402';
 if(sponsored&&(!value.sponsoredPayment||value.sponsoredPayment.sponsor!==challenge.accepted.extra.feePayer||
  (challenge.memo===undefined?!/^[a-f0-9]{32}$/.test(value.sponsoredPayment.memo):value.sponsoredPayment.memo!==challenge.memo)))throw new Error('Sponsored original wire, sponsor or payment reference differs.');
 if(!sponsored&&value.sponsoredPayment)throw new Error('MPP result unexpectedly includes a sponsored transaction.');
 const prefunded=tool.x402Mode==='prefunded';
 if(prefunded&&(!sponsored||!value.fundingSignature)||!prefunded&&value.fundingSignature)throw new Error('HTTP funding proof differs from its configured custody mode.');
 let scope;
 if(prefunded){
  if(challenge.protocol!=='x402'||!value.sponsoredPayment||!value.fundingSignature)throw new Error('Original standard transfer proof is missing.');
  const {verifyPrefundedX402Settlement}=await import('./prefunded-x402-payment.js');
  scope=(await verifyPrefundedX402Settlement({job,action,intentId,sessionKey,fundingFeePayer:feePayer,recipient:tool.recipient,endpoint:tool.endpoint,challenge,rpc,fundingSignature:value.fundingSignature,settlementSignature:value.paymentSignature,partialWire:value.sponsoredPayment.wire,memo:value.sponsoredPayment.memo})).scope;
 }else{
  scope=await autonomousServiceScope({job,action,intentId,sessionKey,feePayer,recipient:tool.recipient,endpoint:tool.endpoint,
   memo:sponsored?value.sponsoredPayment!.memo:challenge.memo,...(sponsored?{rentPayer:sessionKey}:{})});
  if(sponsored)await verifySponsoredSettlement({rpc,genesis:job.genesis,signature:value.paymentSignature,partialWire:value.sponsoredPayment!.wire,sponsor:value.sponsoredPayment!.sponsor,clientSigners:[sessionKey],allowedSponsorAccounts:value.sponsoredPayment!.sponsor===tool.recipient?[{instruction:0,account:7}]:[]});
  await verifyAutonomousTransaction(rpc,value.paymentSignature,job.program,scope.accounts,scope.paymentData,sponsored?value.sponsoredPayment!.sponsor:feePayer,sessionKey,scope.extra);
 }
 if(value.intentId!==intentId||value.execution!==scope.execution)throw new Error('HTTP result belongs to another canonical intent.');
 return scope;
}
export async function verifyAutonomousServiceOutput(input:Omit<Parameters<typeof verifyAutonomousServicePayment>[0],'value'>&{value:GatewayOutput}):Promise<AutonomousReceipt>{
 const {job,action,intentId,value,sessionKey,feePayer,tool,rpc}=input,scope=await verifyAutonomousServicePayment(input);
 await verifyAutonomousTransaction(rpc,value.resultSignature,job.program,scope.resultAccounts,scope.resultData(value.content),feePayer,sessionKey);
 const memory=await rememberVerifiedExecution({agent:job.agent,execution:scope.execution,title:'HTTP '+tool.id,content:value.content,tags:['autonomous',job.id,tool.protocol]});
 if(memory.source!=='skill'||memory.contentHash!==digest(value.content).toString('hex'))throw new Error('Paid service response commitment differs.');
 return {id:scope.execution,output:value.content,outputHash:memory.contentHash,verified:true};
}

import { createHash } from 'node:crypto';
import { address,blockhash,setTransactionMessageFeePayer,getAddressDecoder,addSignersToInstruction,appendTransactionMessageInstructions,compileTransaction,createTransactionMessage,
  getAddressEncoder,getBase64EncodedWireTransaction,getProgramDerivedAddress,getSignatureFromTransaction,getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Decoder,getPublicKeyFromAddress,verifySignature,
  setTransactionMessageFeePayerSigner,setTransactionMessageLifetimeUsingBlockhash,signTransactionMessageWithSigners,
  type Instruction,type TransactionPartialSigner } from '@solana/kit';
import { decodePaymentRequiredHeader,decodePaymentResponseHeader,encodePaymentSignatureHeader,encodePaymentRequiredHeader } from '@x402/core/http';
import { prefundedX402Scope,preparePrefundedX402Payment,verifyPrefundedX402Settlement } from './prefunded-x402-payment.js';
import { prepareSponsoredServicePayment } from './sponsored-service-payment.js';
import { verifySponsoredSettlement } from './standard-settlement.js';
import { parseAutonomousJob,type AutonomousAction,type AutonomousJob } from './autonomous-loop.js';
import { autonomousExecutionId,autonomousSkillScope,autonomousServiceScope,verifyAutonomousServicePayment,verifyAutonomousTransaction } from './autonomous-proof.js';
import { callStandardPaidResource,standardCredential,readStandardChallenge,recoverStandardPaidResponse,recoverMppPaidResponse } from './standard-payments.js';
import { standardToolTerms,validateStandardInput,type StandardTool } from './standard-tools.js';
import { runtimeNetwork } from './chain-network.js';
import type { AutonomousTenant } from './autonomous-controller.js';
import type { GatewayOutput } from './autonomous-gateway.js';
import { HeadlessJournal,type HeadlessRecord } from './headless-journal.js';
import { recoverSavedSkillResponse } from './skill-response-recovery.js';
import { readResponseTextLimited } from './http-limits.js';

type Rpc=(method:string,params:unknown[])=>Promise<any>;
type Options={program:string;genesis:string;rpc:Rpc;feePayer:TransactionPartialSigner;signers:Map<string,TransactionPartialSigner>;
  tenants:AutonomousTenant[];tools:Map<string,string>;standardTools?:Map<string,StandardTool>;mcpTools?:Map<string,string>;recoverSkillResponses?:Set<string>;journal:HeadlessJournal;transport?:typeof fetch};
const hash=(text:string)=>createHash('sha256').update(text).digest();
const discriminator=(name:string)=>hash('account:'+name).subarray(0,8);
const encoder=getAddressEncoder();
const bytes=(key:string)=>Buffer.from(encoder.encode(address(key)));
const pda=async(program:string,seeds:Uint8Array[])=>String((await getProgramDerivedAddress({programAddress:address(program),seeds}))[0]);
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export async function prepareHeadlessTransaction(options:Pick<Options,'rpc'|'feePayer'>,instruction:Instruction|Instruction[],signer:TransactionPartialSigner){
  const {rpc,feePayer}=options,lifetime=(await rpc('getLatestBlockhash',[{commitment:'confirmed'}])).value;
  const message=appendTransactionMessageInstructions((Array.isArray(instruction)?instruction:[instruction]).map(item=>addSignersToInstruction([signer],item)),
    setTransactionMessageLifetimeUsingBlockhash({...lifetime,lastValidBlockHeight:BigInt(lifetime.lastValidBlockHeight)},setTransactionMessageFeePayerSigner(feePayer,createTransactionMessage({version:0}))));
  const unsigned=compileTransaction(message);
  const before=(await rpc('simulateTransaction',[getBase64EncodedWireTransaction(unsigned),{encoding:'base64',sigVerify:false,commitment:'confirmed'}])).value;
  if(before.err!==null)throw new Error('Headless transaction simulation failed before signing.');
  const fee=(await rpc('getFeeForMessage',[Buffer.from(unsigned.messageBytes).toString('base64'),{commitment:'confirmed'}])).value;
  if(!Number.isSafeInteger(fee)||fee<0||fee>10000)throw new Error('Headless transaction exceeds the fee cap.');
  const signed=await signTransactionMessageWithSigners(message),wire=getBase64EncodedWireTransaction(signed);
  if(!Buffer.from(signed.messageBytes).equals(Buffer.from(unsigned.messageBytes)))throw new Error('Wallet modified the fixed headless transaction.');
  for(const key of [feePayer.address,signer.address]){const signature=signed.signatures[key];if(!signature||!await verifySignature(await getPublicKeyFromAddress(key),signature,signed.messageBytes))throw new Error('Headless wallet returned an invalid signature.');}
  // The caller persists this wire before any signed simulation or broadcast.
  return {wire,signature:String(getSignatureFromTransaction(signed))};
 }
export async function confirmHeadlessTransaction(options:Pick<Options,'rpc'>,transaction:{wire:string;signature:string},maySend=true,beforeSend?:()=>void|Promise<void>){
  const {rpc}=options;
  const existing=(await rpc('getSignatureStatuses',[[transaction.signature],{searchTransactionHistory:true}])).value[0];
  if(existing?.err)throw new Error('Original headless transaction failed.');
  if(existing?.confirmationStatus==='finalized')return;
  if(!existing){if(!maySend)throw new Error('Previously observed original transaction is temporarily unavailable; recovery cannot broadcast without simulation.');
   const simulation=(await rpc('simulateTransaction',[transaction.wire,{encoding:'base64',sigVerify:true,commitment:'confirmed'}])).value;if(simulation?.err!==null)throw new Error('Saved signed transaction simulation failed before broadcast.');
   const fee=(await rpc('getFeeForMessage',[Buffer.from(getTransactionDecoder().decode(Buffer.from(transaction.wire,'base64')).messageBytes).toString('base64'),{commitment:'confirmed'}])).value;if(!Number.isSafeInteger(fee)||fee<0||fee>10000)throw new Error('Saved signed transaction exceeds its broadcast fee cap.');
   await beforeSend?.();const sent=await rpc('sendTransaction',[transaction.wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:30}]);if(sent!==transaction.signature)throw new Error('RPC returned another transaction signature.');}
  for(let attempt=0;attempt<200;attempt++){
   const status=(await rpc('getSignatureStatuses',[[transaction.signature],{searchTransactionHistory:true}])).value[0];
   if(status?.err)throw new Error('Original headless transaction failed.');if(status?.confirmationStatus==='finalized')return;await pause(100);
  }
  throw new Error('Original transaction remains unconfirmed; never replace its signed wire.');
 }

/** Actual paid Skill execution independent of browser lifetime. Signers are
 * injected non-exportable wallets; no private keys are serialized or exported.
 * Every effect retains its original signed wire before the first broadcast. */
export class HeadlessSkillExecutor {
 private readonly running=new Map<string,Promise<GatewayOutput>>();
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private readonly options:Options){if((options.recoverSkillResponses?.size??0)>100||[...options.recoverSkillResponses??[]].some(skill=>!options.tools.has(skill)||options.standardTools?.has(skill)))throw new Error('Saved Skill response recovery must select fixed registered tools.');}
 async account(key:string,kind:string,length:number){
  const info=await this.options.rpc('getAccountInfo',[key,{encoding:'base64',commitment:'confirmed'}]);
  const account=info.value;
  if(!account||account.owner!==this.options.program||!Array.isArray(account.data)||account.data[1]!=='base64'||typeof account.data[0]!=='string')throw new Error('Required chain account is missing or belongs to another Program.');
  const data=Buffer.from(account.data[0],'base64');if(data.length!==length||!data.subarray(0,8).equals(discriminator(kind)))throw new Error('Chain account layout is invalid.');return data;
 }
 private async validate(job:AutonomousJob,action:AutonomousAction,intentId:string,alreadyFunded=false){
  const {program,genesis,tenants,signers,tools,rpc}=this.options;
  const mcp=action.tool.startsWith('mcp:'),standard=this.options.standardTools?.get(action.tool),permission=standard?5:4;
  const profile=tenants.find(profile=>profile.tenant===job.tenant),signer=signers.get(job.tenant),endpoint=standard?.endpoint??(mcp?this.options.mcpTools?.get(action.tool):tools.get(action.tool));
  if(standard&&(standard.asset!==action.asset||standard.amount!==action.amount))throw new Error('Standard tool differs from its supported fixed quote.');
  if(standard)validateStandardInput(standard,action.input);
  if(standard?.x402Mode==='prefunded'&&profile?.allowSessionTokenCustody!==true)throw new Error('Tenant has not enabled Session-owned USDC custody.');
  if(!profile||!signer||!endpoint||job.program!==program||job.genesis!==genesis||await rpc('getGenesisHash',[])!==genesis
    ||job.agent!==profile.agent||job.session!==profile.session||job.limits.deadline>Math.floor(Date.now()/1000)+profile.maxDurationSeconds
    ||BigInt(job.limits.sol)>BigInt(profile.limits.sol)||BigInt(job.limits.usdc)>BigInt(profile.limits.usdc)
    ||job.limits.maxActions>profile.limits.maxActions||job.limits.maxCycles>profile.limits.maxCycles||job.limits.maxModelRequests>profile.limits.maxModelRequests
    ||job.limits.tools.some(tool=>!profile.limits.tools.includes(tool))||!job.limits.tools.includes(action.tool))throw new Error('Headless job exceeds its independently configured scope.');
  const gross=job.intents.reduce((total,intent)=>{if(intent.action.asset==='SOL')total.sol+=BigInt(intent.action.amount);else total.usdc+=BigInt(intent.action.amount);return total;},{sol:0n,usdc:0n});
  if(job.state!=='executing'||job.intents.length>job.limits.maxActions||gross.sol>BigInt(job.limits.sol)||gross.usdc>BigInt(job.limits.usdc)
    ||gross.sol!==BigInt(job.spent.sol)||gross.usdc!==BigInt(job.spent.usdc)||new Set(job.intents.map(intent=>intent.action.key)).size!==job.intents.length
    ||job.intents.some(intent=>!job.limits.tools.includes(intent.action.tool)))throw new Error('Headless gross reservations differ from the fixed job budget.');
  const session=await this.account(job.session,'Session',147);
  if(!session.subarray(8,40).equals(bytes(job.agent))||!session.subarray(40,72).equals(bytes(signer.address))||session[105]!==0
    ||session[104]>15||(session[104]&permission)!==permission||session.subarray(115,123).equals(Buffer.from('AGTASK01'))||session.readBigInt64LE(72)<BigInt(job.limits.deadline)
    ||job.limits.deadline<=Math.floor(Date.now()/1000))throw new Error('Headless Session is inactive, task-bound, expired or belongs to another signer.');
  if(await pda(program,[Buffer.from('session'),bytes(job.agent),bytes(signer.address)])!==job.session)throw new Error('Headless Session PDA differs.');
  const [agent,skill,policy]=await Promise.all([this.account(job.agent,'Agent',138),(standard||mcp)?Promise.resolve(null):this.account(action.tool,'Skill',130),
    this.account(await pda(program,[Buffer.from('policy'),bytes(job.agent)]),'Policy',123)]);
  if(agent[104]!==0||await pda(program,[Buffer.from('agent'),agent.subarray(8,40),agent.subarray(40,72)])!==job.agent
    ||skill&&(skill[112]!==1||await pda(program,[Buffer.from('skill'),skill.subarray(8,40),skill.subarray(40,72)])!==action.tool||!skill.subarray(72,104).equals(hash(endpoint)))
    ||policy[73]!==0||policy[72]>15||(policy[72]&permission)!==permission||!policy.subarray(8,40).equals(bytes(job.agent)))throw new Error('Headless Agent, Policy or registered endpoint is inactive or mismatched.');
  if(mcp){if(action.asset!=='SOL'||action.amount!=='0')throw new Error('Shared MCP tools require a free SOL reservation.');return {signer,endpoint,standard,provider:''};}
  const amount=BigInt(action.amount),isSol=action.asset==='SOL';
  const price=standard?BigInt(standard.amount):skill!.readBigUInt64LE(isSol?104:114),per=session.readBigUInt64LE(isSol?80:123),total=session.readBigUInt64LE(isSol?88:131),spent=session.readBigUInt64LE(isSol?96:139);
  const daily=policy.readBigUInt64LE(isSol?40:91),perPolicy=policy.readBigUInt64LE(isSol?48:99);
  const spentPolicy=policy.readBigInt64LE(isSol?64:115)===BigInt(Math.floor(Date.now()/86400000))?policy.readBigUInt64LE(isSol?56:107):0n;
  if(amount===0n||amount!==price||amount>per||amount>perPolicy||(alreadyFunded?spent>total||spentPolicy>daily||agent.readBigUInt64LE(113)!==autonomousExecutionId(job,intentId)+1n:amount+spent>total||amount+spentPolicy>daily||agent.readBigUInt64LE(113)!==autonomousExecutionId(job,intentId)))throw new Error('Headless price, allowance or reserved execution counter changed.');
  const url=new URL(endpoint);if(url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('Headless endpoint must be HTTPS or local loopback.');
  return {signer,endpoint,standard,provider:standard?.recipient??String((await import('@solana/kit')).getAddressDecoder().decode(skill!.subarray(8,40)))};
 }
 async validateMcp(job:AutonomousJob,action:AutonomousAction,intentId:string){
  if(!action.tool.startsWith('mcp:'))throw new Error('Shared MCP route requires an MCP tool.');
  await this.validate(job,action,intentId);
 }
 execute(value:unknown,action:AutonomousAction,intentId:string):Promise<GatewayOutput>{
  if(action.tool.startsWith('mcp:'))return Promise.reject(new Error('Use the separate shared MCP execution route.'));
  const job=parseAutonomousJob(value),intent=job.intents.find(intent=>intent.id===intentId);
  if(!intent||intent.phase!=='reserved'||['key','tool','input','asset','amount'].some(key=>intent.action[key as keyof AutonomousAction]!==action[key as keyof AutonomousAction]))return Promise.reject(new Error('Execution does not match its durable reserved intent.'));
  const key=job.tenant+':'+job.id+':'+intentId,existing=this.running.get(key);if(existing)return existing;
  const run=this.tail.then(()=>this.dispatch(job,intent.action,intentId));this.tail=run.catch(()=>{});
  this.running.set(key,run);void run.finally(()=>this.running.delete(key)).catch(()=>{});return run;
 }
 result(tenant:string,jobId:string,intentId:string):GatewayOutput|null{
  const record=this.options.journal.load(tenant,jobId,intentId);return record?.complete?this.output(record):null;
 }
 /** Recover only effects already finalized under their saved original signatures.
  * Result retrieval never signs, broadcasts or calls the paid provider. Earlier
  * incomplete stages remain unresolved; Runtime verifies the full effect scope. */
 async reconcileResult(tenant:string,jobId:string,intentId:string):Promise<GatewayOutput|null>{
  const record=this.options.journal.load(tenant,jobId,intentId);
  if(!record)return null;if(record.complete)return this.output(record);
  if(!record.payment||!record.result||record.content===undefined)return null;
  const {rpc,genesis,program,feePayer,journal}=this.options,profile=this.options.tenants.find(value=>value.tenant===tenant),signer=this.options.signers.get(tenant);
  if(!profile||!signer)throw new Error('Original recovery tenant or signer identity is unavailable.');
  if(await rpc('getGenesisHash',[])!==genesis)throw new Error('Original recovery RPC belongs to another chain.');
  const finalized:{slot:number}[]=[];
  for(const transaction of [...(record.funding?[record.funding]:[]),record.payment,record.result]){
   const result=await this.finalizedOriginal(transaction);if(!result)return null;
   finalized.push(result);
  }
  if(finalized.some((value,index)=>index>0&&value.slot<finalized[index-1].slot))throw new Error('Original result was finalized before its payment or funding.');
  await verifyAutonomousTransaction(rpc,record.result.signature,program,[signer.address,feePayer.address,profile.agent,profile.session,record.execution],Buffer.concat([hash('global:record_skill_result').subarray(0,8),hash(record.content)]),feePayer.address,signer.address);
  record.complete=true;journal.save(record);return this.output(record);
 }
 private async finalizedOriginal(transaction:{wire:string;signature:string}){
  const {rpc}=this.options;
  const result=await rpc('getTransaction',[transaction.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
  if(!result)return null;
  if(result.meta?.err!==null||!Number.isSafeInteger(result.meta.fee)||result.meta.fee<0||result.meta.fee>10000||!Number.isSafeInteger(result.slot)||result.slot<0||!Array.isArray(result.transaction)||result.transaction[1]!=='base64'||result.transaction[0]!==transaction.wire)throw new Error('Saved original transaction is failed, altered or outside its finalized fee/slot scope.');
  const original=getTransactionDecoder().decode(Buffer.from(transaction.wire,'base64')),message=getCompiledTransactionMessageDecoder().decode(original.messageBytes);
  if(message.version===1||'addressTableLookups' in message&&(message.addressTableLookups?.length??0)>0)throw new Error('Original recovery transaction uses an unsupported message.');
  const required=message.staticAccounts.slice(0,message.header.numSignerAccounts),first=original.signatures[message.staticAccounts[0]];
  if(!first||getBase58Decoder().decode(first)!==transaction.signature)throw new Error('Original recovery transaction signature differs.');
  for(const key of required){const bytes=original.signatures[key];if(!bytes||!await verifySignature(await getPublicKeyFromAddress(key),bytes,original.messageBytes))throw new Error('Original recovery transaction signature is invalid.');}
  return result;
 }
 /** Explicit recovery operation: finishes only the saved paid response result
  * registration. Existing signatures are immutable; a missing result requires
  * live original delegation. Provider access is limited to opt-in cache retrieval. */
 recoverResult(value:unknown,action:AutonomousAction,intentId:string):Promise<GatewayOutput|null>{
  const job=parseAutonomousJob(value),intent=job.intents.find(item=>item.id===intentId);
  if(!intent||intent.phase!=='reserved'||['key','tool','input','asset','amount'].some(key=>intent.action[key as keyof AutonomousAction]!==action[key as keyof AutonomousAction]))return Promise.reject(new Error('Recovery differs from its durable reserved intent.'));
  const key=job.tenant+':'+job.id+':'+intentId,existing=this.running.get(key);if(existing)return existing;
  // Serialize with paid execution: recovery cannot race a new effect allocation.
  const run=this.tail.then(()=>this.resumeResult(job,action,intentId));this.tail=run.catch(()=>{});return run;
 }
 private async resumeResult(job:AutonomousJob,action:AutonomousAction,intentId:string):Promise<GatewayOutput|null>{
  const {journal,rpc,program,genesis,feePayer}=this.options,record=journal.load(job.tenant,job.id,intentId);
  if(!record||!record.payment)return null;
  const legacyRecovery=!this.options.standardTools?.has(action.tool)&&this.options.recoverSkillResponses?.has(action.tool);
  if(record.content===undefined&&(!(this.options.standardTools?.get(action.tool)?.recoverResponse||legacyRecovery)||(record.responseRecoveries??0)>=3))return null;
  const signer=this.options.signers.get(job.tenant),profile=this.options.tenants.find(item=>item.tenant===job.tenant),tool=this.options.standardTools?.get(action.tool),endpoint=tool?.endpoint??this.options.tools.get(action.tool);
  if(!signer||!profile||!endpoint||job.program!==program||job.genesis!==genesis||job.agent!==profile.agent||job.session!==profile.session||!profile.limits.tools.includes(action.tool)||!job.limits.tools.includes(action.tool))throw new Error('Original recovery scope differs from the configured tenant.');
  const base={job,action,intentId,sessionKey:signer.address,feePayer:feePayer.address,recipient:tool?.recipient,endpoint};
  const expectedHash=tool?hash(JSON.stringify({...base,job:{agent:job.agent,session:job.session,program,genesis,limits:job.limits},tool,executionId:autonomousExecutionId(job,intentId).toString()})).toString('hex'):hash(JSON.stringify({agent:job.agent,session:job.session,program,genesis,action,executionId:autonomousExecutionId(job,intentId).toString(),limits:job.limits,endpoint,feePayer:feePayer.address,sessionKey:signer.address})).toString('hex');
  if(record.scopeHash!==expectedHash)throw new Error('Signed result recovery cannot change its original job, tool or budget scope.');
  const ready=await this.reconcileResult(job.tenant,job.id,intentId);if(ready)return ready;
  let scope;
  if(tool)scope=await verifyAutonomousServicePayment({job,action,intentId,value:this.paymentProof(record),sessionKey:signer.address,feePayer:feePayer.address,tool,rpc});
  else {const provider=String(getAddressDecoder().decode((await this.account(action.tool,'Skill',130)).subarray(8,40)));scope=await autonomousSkillScope({job,action,intentId,sessionKey:signer.address,feePayer:feePayer.address,provider});await verifyAutonomousTransaction(rpc,record.payment.signature,program,scope.accounts,scope.paymentData,feePayer.address,signer.address);}
  if(record.execution!==scope.execution)throw new Error('Original result Execution differs from its reserved action.');
  if(record.content===undefined){
   if(!record.paymentHeader||!legacyRecovery&&(!tool?.recoverResponse||!record.paymentChallenge||tool.protocol==='x402'&&!record.sponsoredPayment))throw new Error('Original cached response recovery metadata is missing.');
   if(!['executing','needs_reconciliation'].includes(job.state)||job.limits.deadline<=Math.floor(Date.now()/1000))throw new Error('Original job is stopped or expired; response recovery cannot contact the provider.');
   await this.validate({...job,state:'executing'},action,intentId,true);
   if(legacyRecovery){
    const provider=String(getAddressDecoder().decode((await this.account(action.tool,'Skill',130)).subarray(8,40)));
    record.content=await recoverSavedSkillResponse({endpoint,program,genesis,agent:job.agent,skill:action.tool,provider,asset:action.asset,amount:action.amount,input:action.input,inputHash:scope.inputHash.toString('hex'),execution:scope.execution,signature:record.payment.signature},record.paymentHeader,()=>{record.responseRecoveries=(record.responseRecoveries??0)+1;journal.save(record);},this.options.transport??fetch);journal.save(record);
   }else{
   if(!tool?.recoverResponse||!record.paymentChallenge)throw new Error('Original cached response recovery metadata is missing.');
   validateStandardInput(tool,action.input);
   const terms=standardToolTerms(tool,runtimeNetwork().cluster,job.genesis),challenge=readStandardChallenge(new Response(null,{status:402,headers:{[tool.protocol==='mpp'?'www-authenticate':'payment-required']:record.paymentChallenge}}),terms,0);
   // Persist before dispatch, so a process crash still consumes one bounded attempt.
   record.responseRecoveries=(record.responseRecoveries??0)+1;journal.save(record);
   const input={method:tool.method,...(tool.method==='POST'?{body:action.input}:{})},verify=async()=>{await verifyAutonomousServicePayment({job,action,intentId,value:this.paymentProof(record),sessionKey:signer.address,feePayer:feePayer.address,tool,rpc});};
   record.content=tool.protocol==='mpp'?await recoverMppPaidResponse(terms,input,challenge,record.paymentHeader,record.payment.signature,this.options.transport??fetch,verify):
    await recoverStandardPaidResponse(terms,{...input,paymentIdentifier:'pay_'+intentId,originalTransaction:record.sponsoredPayment!.wire},challenge,record.paymentHeader,record.payment.signature,this.options.transport??fetch,verify);
   journal.save(record);
   }
  }
  const instruction:Instruction={programAddress:address(program),accounts:scope.resultAccounts.map((key,index)=>({address:address(key),role:[2,3,0,0,1][index]})),data:scope.resultData(record.content)};
  if(!record.result){
   if(!['executing','needs_reconciliation'].includes(job.state)||job.limits.deadline<=Math.floor(Date.now()/1000))throw new Error('Original job is stopped or expired; recovery cannot sign.');
   // The original payment already consumed its execution counter and budget.
   // Recheck live authority without reserving or allocating another payment.
   await this.validate({...job,state:'executing'},action,intentId,true);
   record.result=await this.signed(instruction,signer);journal.save(record);
  }
  const original=getTransactionDecoder().decode(Buffer.from(record.result.wire,'base64')),message=getCompiledTransactionMessageDecoder().decode(original.messageBytes);
  if(message.version!==0||(message.addressTableLookups?.length??0)>0)throw new Error('Signed result recovery requires the original static v0 message.');
  const expected=compileTransaction(appendTransactionMessageInstructions([instruction],setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(message.lifetimeToken),lastValidBlockHeight:0n},setTransactionMessageFeePayer(feePayer.address,createTransactionMessage({version:0})))));
  if(!Buffer.from(expected.messageBytes).equals(Buffer.from(original.messageBytes))||getBase58Decoder().decode(original.signatures[feePayer.address]!)!==record.result.signature)throw new Error('Original signed result differs from its exact output commitment.');
  for(const key of [feePayer.address,signer.address]){const signature=original.signatures[key];if(!signature||!await verifySignature(await getPublicKeyFromAddress(key),signature,original.messageBytes))throw new Error('Original signed result signature is invalid.');}
  const status=(await rpc('getSignatureStatuses',[[record.result.signature],{searchTransactionHistory:true}])).value[0];
  if(status?.err)throw new Error('Original result transaction failed; it cannot be replaced.');
  if(!status){
   if(!['executing','needs_reconciliation'].includes(job.state)||job.limits.deadline<=Math.floor(Date.now()/1000))throw new Error('Original job is stopped or expired; recovery cannot broadcast.');
   const simulation=(await rpc('simulateTransaction',[record.result.wire,{encoding:'base64',sigVerify:true,commitment:'confirmed'}])).value;
   if(simulation?.err!==null)throw new Error('Original signed result no longer simulates; never replace its wire.');
   const fee=(await rpc('getFeeForMessage',[Buffer.from(original.messageBytes).toString('base64'),{commitment:'confirmed'}])).value;
   if(!Number.isSafeInteger(fee)||fee<0||fee>10000)throw new Error('Original result recovery exceeds its fee cap.');
  }
  await this.confirm(record.result,!status,()=>{if(job.limits.deadline<=Math.floor(Date.now()/1000))throw new Error('Original job expired before recovery broadcast.');});return this.reconcileResult(job.tenant,job.id,intentId);
 }
 private paymentProof(record:HeadlessRecord):Omit<GatewayOutput,'resultSignature'|'content'>{
  if(!record.payment)throw new Error('Original payment is incomplete.');
  return {intentId:record.intentId,execution:record.execution,paymentSignature:record.payment.signature,...(record.funding?{fundingSignature:record.funding.signature}:{}),...(record.paymentChallenge?{paymentChallenge:record.paymentChallenge}:{}),...(record.sponsoredPayment?{sponsoredPayment:record.sponsoredPayment}:{})};
 }
 private paidOutput(record:HeadlessRecord):Omit<GatewayOutput,'resultSignature'>{
  if(record.content===undefined)throw new Error('Original paid response is incomplete.');
  return {...this.paymentProof(record),content:record.content};
 }
 private output(record:HeadlessRecord):GatewayOutput{
  if(!record.result)throw new Error('Original intent is incomplete.');return {...this.paidOutput(record),resultSignature:record.result.signature};
 }
 private signed(instruction:Instruction|Instruction[],signer:TransactionPartialSigner){return prepareHeadlessTransaction(this.options,instruction,signer);}
 private confirm(transaction:{wire:string;signature:string},maySend=true,beforeSend?:()=>void){return confirmHeadlessTransaction(this.options,transaction,maySend,beforeSend);}
 private async dispatch(job:AutonomousJob,action:AutonomousAction,intentId:string):Promise<GatewayOutput>{
  const {journal,feePayer,program,genesis}=this.options;
  const old=journal.load(job.tenant,job.id,intentId);
  if(old?.complete)return this.output(old);
  // An incomplete original attempt is recovered from its original journal by
  // explicit operator reconciliation, never by allocating another payment.
  if(old)throw new Error('Original intent is incomplete and requires reconciliation.');
  const {signer,endpoint,provider,standard}=await this.validate(job,action,intentId);
  if(standard)return this.dispatchStandard(job,action,intentId,standard,signer);
  const scope=await autonomousSkillScope({job,action,intentId,sessionKey:signer.address,feePayer:feePayer.address,provider});
  const record:HeadlessRecord={tenant:job.tenant,jobId:job.id,intentId,execution:scope.execution,complete:false,
    scopeHash:hash(JSON.stringify({agent:job.agent,session:job.session,program,genesis,action,executionId:autonomousExecutionId(job,intentId).toString(),limits:job.limits,endpoint,feePayer:feePayer.address,sessionKey:signer.address})).toString('hex')};
  journal.save(record);
  const call=(headers:Record<string,string>={})=>(this.options.transport??fetch)(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json',...headers},signal:AbortSignal.timeout(55_000),
    body:JSON.stringify({protocol:'agentos-skill-v2',agent:job.agent,paymentPreference:action.asset,skill:{address:action.tool},request:{skill:action.tool,prompt:action.input,sha256:scope.inputHash.toString('hex')}})});
  const challenge=await call();if(challenge.status!==402){await challenge.body?.cancel();throw new Error('Registered tool did not return a payment challenge.');}
  const required=decodePaymentRequiredHeader(challenge.headers.get('PAYMENT-REQUIRED')??'');await challenge.body?.cancel();
  const accepted=required.accepts.find(item=>item.scheme==='agentos-vault'&&item.asset===(action.asset==='SOL'?'SOL':'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'));
  if(!accepted||accepted.network!==`solana:${genesis.slice(0,32)}`||accepted.amount!==action.amount||accepted.payTo!==provider||required.resource.url!==endpoint
    ||accepted.extra.programId!==program||accepted.extra.skill!==action.tool||accepted.extra.inputHash!==scope.inputHash.toString('hex'))throw new Error('Tool challenge differs from the registered authorized terms.');
  // Re-check chain permissions after the untrusted remote challenge.
  await this.validate(job,action,intentId);
  const roles=action.asset==='SOL'?[2,3,1,1,1,1,0,1,1,0]:[2,3,1,1,1,0,1,0,1,1,1,0,0,0];
  record.payment=await this.signed({programAddress:address(program),accounts:scope.accounts.map((key,index)=>({address:address(key),role:roles[index]})),data:scope.paymentData},signer);
  record.paymentHeader=encodePaymentSignatureHeader({x402Version:2,resource:required.resource,accepted,payload:{agent:job.agent,skill:action.tool,inputHash:scope.inputHash.toString('hex'),execution:scope.execution,signature:record.payment.signature}});
  journal.save(record);await this.confirm(record.payment);
  const response=await call({'PAYMENT-SIGNATURE':record.paymentHeader});
  const content=await readResponseTextLimited(response,65536,'Provider output exceeds its bounded result size.');
  if(response.status!==200)throw new Error('Paid provider did not return a successful original result.');
  const settlement=decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')??'');
  if(!settlement.success||settlement.transaction!==record.payment.signature)throw new Error('Provider settlement differs from the original payment.');
  record.content=content;journal.save(record);
  record.result=await this.signed({programAddress:address(program),accounts:scope.resultAccounts.map((key,index)=>({address:address(key),role:[2,3,0,0,1][index]})),data:scope.resultData(content)},signer);
  journal.save(record);await this.confirm(record.result);record.complete=true;journal.save(record);return this.output(record);
 }
 private async dispatchStandard(job:AutonomousJob,action:AutonomousAction,intentId:string,tool:StandardTool,signer:TransactionPartialSigner):Promise<GatewayOutput>{
  const {program,genesis,feePayer,journal}=this.options,terms=standardToolTerms(tool,runtimeNetwork().cluster,genesis);
  const base={job,action,intentId,sessionKey:signer.address,feePayer:feePayer.address,recipient:tool.recipient,endpoint:tool.endpoint};
  let scope=await autonomousServiceScope(base);
  const record:HeadlessRecord={tenant:job.tenant,jobId:job.id,intentId,execution:scope.execution,complete:false,
   scopeHash:hash(JSON.stringify({...base,job:{agent:job.agent,session:job.session,program,genesis,limits:job.limits},tool,executionId:autonomousExecutionId(job,intentId).toString()})).toString('hex')};
  journal.save(record);
  const delivered=await callStandardPaidResource(terms,{method:tool.method,paymentIdentifier:'pay_'+intentId,...(tool.method==='POST'?{body:action.input}:{})},async challenge=>{
   await this.validate(job,action,intentId);
   if(challenge.protocol==='x402'){
    let prepared;
    if(tool.x402Mode==='prefunded'){
     const fundingBase={job,action,intentId,sessionKey:signer.address,fundingFeePayer:feePayer.address,recipient:tool.recipient,endpoint:tool.endpoint,challenge};
     scope=await prefundedX402Scope(fundingBase);
     record.paymentChallenge=encodePaymentRequiredHeader(challenge.required);
     const roles=[2,3,1,1,1,0,1,0,1,1,0,0,0];
     record.funding=await this.signed({programAddress:address(program),accounts:scope.accounts.map((key,index)=>({address:address(key),role:roles[index]})),data:scope.paymentData},signer);
     journal.save(record);await this.confirm(record.funding);
     await this.validate(job,action,intentId,true);
     prepared=await preparePrefundedX402Payment({...fundingBase,signer,fundingSignature:record.funding.signature,rpc:this.options.rpc});
    }else prepared=await prepareSponsoredServicePayment({job,action,intentId,signer,resultFeePayer:feePayer.address,recipient:tool.recipient,endpoint:tool.endpoint,challenge,rpc:this.options.rpc});
    scope=prepared.scope;record.sponsoredPayment={wire:prepared.wire,sponsor:prepared.sponsor,memo:prepared.memo};
    record.paymentChallenge=encodePaymentRequiredHeader(challenge.required);
    record.paymentHeader=standardCredential(challenge,{transaction:prepared.wire},'pay_'+intentId).value;
    // The sponsor may now co-sign/broadcast. Original partial wire is immutable.
    journal.save(record);return {transaction:prepared.wire};
   }
   scope=await autonomousServiceScope({...base,memo:challenge.memo});
   record.paymentChallenge='Payment '+Object.entries(challenge.auth).map(([key,value])=>key+'='+JSON.stringify(value)).join(', ');
   const roles=action.asset==='SOL'?[2,3,1,1,1,1,1,1,0]:[2,3,1,1,1,0,1,0,1,1,0,0,0];
   const instruction:Instruction={programAddress:address(program),accounts:scope.accounts.map((key,index)=>({address:address(key),role:roles[index]})),data:scope.paymentData};
   record.payment=await this.signed([instruction,...scope.extra.map(item=>({programAddress:address(item.program),accounts:item.accounts.map(key=>({address:address(key),role:2 as const})),data:item.data}))],signer);
   record.paymentHeader=standardCredential(challenge,{signature:record.payment.signature}).value;
   journal.save(record);await this.confirm(record.payment);return {signature:record.payment.signature};
  },this.options.transport??fetch,async(challenge,_payment,settled)=>{
   if(challenge.protocol==='x402'){
    if(!record.sponsoredPayment)throw new Error('Original partial payment is missing.');
    // The sponsor may report confirmation before finality; poll only this signature.
    for(let n=0;n<200;n++){const status=(await this.options.rpc('getSignatureStatuses',[[settled],{searchTransactionHistory:true}])).value[0];
     if(status?.err)throw new Error('Original sponsored settlement failed.');if(status?.confirmationStatus==='finalized')break;if(n===199)throw new Error('Original sponsored settlement is not finalized.');await pause(100);}
    let result;
    if(tool.x402Mode==='prefunded'){
     if(!record.funding)throw new Error('Original budget allocation is missing.');
     result=(await verifyPrefundedX402Settlement({job,action,intentId,sessionKey:signer.address,fundingFeePayer:feePayer.address,recipient:tool.recipient,endpoint:tool.endpoint,challenge,rpc:this.options.rpc,fundingSignature:record.funding.signature,settlementSignature:settled,partialWire:record.sponsoredPayment.wire,memo:record.sponsoredPayment.memo})).settlement;
    }else {
     result=await verifySponsoredSettlement({rpc:this.options.rpc,genesis,signature:settled,partialWire:record.sponsoredPayment.wire,sponsor:record.sponsoredPayment.sponsor,clientSigners:[signer.address],allowedSponsorAccounts:record.sponsoredPayment.sponsor===tool.recipient?[{instruction:0,account:7}]:[]});
    await verifyAutonomousTransaction(this.options.rpc,settled,program,scope.accounts,scope.paymentData,record.sponsoredPayment.sponsor,signer.address,scope.extra);
    }
    record.payment={signature:settled,wire:result.transaction[0]};journal.save(record);
   }else await verifyAutonomousTransaction(this.options.rpc,settled,program,scope.accounts,scope.paymentData,feePayer.address,signer.address,scope.extra);
  });
  record.content=delivered.content;journal.save(record);
  record.result=await this.signed({programAddress:address(program),accounts:scope.resultAccounts.map((key,index)=>({address:address(key),role:[2,3,0,0,1][index]})),data:scope.resultData(delivered.content)},signer);
  journal.save(record);await this.confirm(record.result);record.complete=true;journal.save(record);return this.output(record);
 }
}

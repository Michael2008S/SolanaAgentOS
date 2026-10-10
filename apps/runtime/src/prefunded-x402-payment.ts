import { createHash,randomBytes } from 'node:crypto';
import { address,blockhash,getTransactionDecoder,getCompiledTransactionMessageDecoder,addSignersToInstruction,appendTransactionMessageInstructions,compileTransaction,createTransactionMessage,getAddressEncoder,getProgramDerivedAddress,
 getBase64EncodedWireTransaction,getPublicKeyFromAddress,partiallySignTransactionMessageWithSigners,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,verifySignature,
 type TransactionPartialSigner,type Instruction } from '@solana/kit';
import { verifySponsoredSettlement } from './standard-settlement.js';
import { canonicalJson } from './canonical-json.js';
import { autonomousServiceScope,verifyAutonomousTransaction } from './autonomous-proof.js';
import { parseAutonomousJob,type AutonomousAction,type AutonomousJob } from './autonomous-loop.js';
import type { StandardPaymentChallenge } from './standard-payments.js';
const mint='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',ata='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',compute='ComputeBudget111111111111111111111111111111',memoProgram='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const encode=getAddressEncoder();
const tokenAddress=async(owner:string)=>String((await getProgramDerivedAddress({programAddress:address(ata),seeds:[encode.encode(address(owner)),encode.encode(address(token)),encode.encode(address(mint))]}))[0]);
type Quote=Extract<StandardPaymentChallenge,{protocol:'x402'}>;
type Base={job:AutonomousJob;action:AutonomousAction;intentId:string;sessionKey:string;fundingFeePayer:string;recipient:string;endpoint:string;challenge:Quote};
function validate(input:Base){
 parseAutonomousJob(input.job);
 const {job,action,challenge,recipient,endpoint,sessionKey,fundingFeePayer,intentId}=input,quote=challenge.accepted,intent=job.intents.find(item=>item.id===intentId),sponsor=quote.extra?.feePayer;
 if(!intent||intent.phase!=='reserved'||JSON.stringify(intent.action)!==JSON.stringify(action)||!job.limits.tools.includes(action.tool)||!action.tool.startsWith('http:')||action.asset!=='USDC'||!/^([1-9][0-9]{0,19})$/.test(action.amount)||BigInt(action.amount)>18446744073709551615n||BigInt(job.spent.usdc)<BigInt(action.amount)||BigInt(job.spent.usdc)>BigInt(job.limits.usdc)||BigInt(job.spent.sol)>BigInt(job.limits.sol))throw new Error('Prefunded payment differs from its durable USDC reservation.');
 if(quote.scheme!=='exact'||quote.network!==`solana:${job.genesis.slice(0,32)}`||quote.asset!==mint||quote.amount!==action.amount||quote.payTo!==recipient||challenge.required.x402Version!==2||challenge.required.resource?.url!==new URL(endpoint).href||typeof sponsor!=='string'||sponsor===sessionKey||sponsor===recipient||sponsor===job.agent||sponsor===job.session||sessionKey===fundingFeePayer)throw new Error('Prefunded x402 quote or signer separation differs from its pinned scope.');
 const url=new URL(endpoint);if(url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))||!Number.isSafeInteger(quote.maxTimeoutSeconds)||quote.maxTimeoutSeconds<1||quote.maxTimeoutSeconds>300||!challenge.required.accepts.some(item=>canonicalJson(item)===canonicalJson(quote))||challenge.accepted.extra?.memo!==challenge.memo)throw new Error('Prefunded quote encoding, endpoint or memo differs.');
 address(sessionKey);address(sponsor);address(recipient);address(fundingFeePayer);
}
/** A separate, ordinary AgentOS payment allocates funds to the protected
 * Session token account and charges API|PAY Policy/Session budgets exactly once.
 * Commit the vendor quote in that Execution rather than calling it settlement. */
export async function prefundedX402Scope(input:Base){
 validate(input);
 const scope=await autonomousServiceScope({job:input.job,action:input.action,intentId:input.intentId,sessionKey:input.sessionKey,feePayer:input.fundingFeePayer,recipient:input.sessionKey,endpoint:input.endpoint});
 const inputHash=createHash('sha256').update(canonicalJson({domain:'agentos-x402-prefund-v1',agent:input.job.agent,session:input.job.session,genesis:input.job.genesis,tool:input.action.tool,input:input.action.input,endpoint:input.endpoint,recipient:input.recipient,sender:input.sessionKey,accepted:input.challenge.accepted,resource:input.challenge.required.resource})).digest();
 const paymentData=Buffer.from(scope.paymentData);inputHash.copy(paymentData,16);
 return {...scope,inputHash,paymentData};
}
function ordinaryInstructions(source:string,destination:string,sessionKey:string,amount:string,memo:string):Instruction[]{
 const limit=Buffer.alloc(5);limit[0]=2;limit.writeUInt32LE(100000,1);const price=Buffer.alloc(9);price[0]=3; // deliberate compute cap and zero priority fee
 const transfer=Buffer.alloc(10);transfer[0]=12;transfer.writeBigUInt64LE(BigInt(amount),1);transfer[9]=6;
 return [{programAddress:address(compute),data:limit},{programAddress:address(compute),data:price},
  {programAddress:address(token),accounts:[{address:address(source),role:1},{address:address(mint),role:0},{address:address(destination),role:1},{address:address(sessionKey),role:2}],data:transfer},
  {programAddress:address(memoProgram),data:Buffer.from(memo)}];
}
/** Builds a default-facilitator-compatible client partial, only after verifying
 * finalized budget allocation. Does not fund, broadcast, retry or change quotes.
 * The caller must opt in to Session-owned token custody, check live Session
 * authorization, and durably store the original before giving it to a facilitator.
 * Revocation stops new funding; it cannot recall an already allocated balance
 * or an ordinary transfer already signed with the Session key. */
export async function preparePrefundedX402Payment(input:Omit<Base,'sessionKey'>&{signer:TransactionPartialSigner;fundingSignature:string;rpc:(method:string,params:unknown[])=>Promise<any>}){
 const {signer,rpc}=input,base={...input,sessionKey:signer.address};validate(base);
 const assertLive=()=>{if(input.job.state!=='executing'||Math.floor(Date.now()/1000)>=input.job.limits.deadline)throw new Error('Prefunded payment job is not executing within its original deadline.');};assertLive();
 if(await rpc('getGenesisHash',[])!==input.job.genesis)throw new Error('Prefunded payment RPC belongs to another chain.');
 const scope=await prefundedX402Scope(base),funding=await verifyAutonomousTransaction(rpc,input.fundingSignature,input.job.program,scope.accounts,scope.paymentData,input.fundingFeePayer,signer.address);
 if(!Number.isSafeInteger(funding.slot)||funding.slot<0)throw new Error('Funding transaction has no valid finalized slot.');
 const source=await tokenAddress(signer.address),destination=await tokenAddress(input.recipient);
 for(const [key,owner,minimum] of [[source,signer.address,BigInt(input.action.amount)],[destination,input.recipient,0n]] as const){
  const result=await rpc('getAccountInfo',[key,{encoding:'base64',commitment:'finalized',minContextSlot:funding.slot}]),account=result?.value;
  if(!Number.isSafeInteger(result?.context?.slot)||result.context.slot<funding.slot||!account||account.owner!==token||account.executable!==false||!Array.isArray(account.data)||account.data[1]!=='base64'||typeof account.data[0]!=='string')throw new Error('Prefunded token account is absent, stale or not canonical classic USDC.');
  const bytes=Buffer.from(account.data[0],'base64');
  if(bytes.toString('base64')!==account.data[0]||bytes.length!==165||!bytes.subarray(0,32).equals(Buffer.from(encode.encode(address(mint))))||!bytes.subarray(32,64).equals(Buffer.from(encode.encode(address(owner))))||bytes[108]!==1||bytes.readUInt32LE(72)!==0||bytes.readUInt32LE(109)!==0||bytes.readUInt32LE(129)!==0||bytes.readBigUInt64LE(64)<minimum)throw new Error('Prefunded token mint, authority, state or balance differs.');
 }
 const sponsor=String(input.challenge.accepted.extra.feePayer),memo=input.challenge.memo??randomBytes(16).toString('hex');if(Buffer.byteLength(memo)>256)throw new Error('Prefunded payment memo exceeds 256 bytes.');
 const instructions=ordinaryInstructions(source,destination,signer.address,input.action.amount,memo);
 const lifetime=(await rpc('getLatestBlockhash',[{commitment:'confirmed'}])).value;
 const message=appendTransactionMessageInstructions(instructions.map(ix=>addSignersToInstruction([signer],ix)),setTransactionMessageLifetimeUsingBlockhash({...lifetime,lastValidBlockHeight:BigInt(lifetime.lastValidBlockHeight)},setTransactionMessageFeePayer(address(sponsor),createTransactionMessage({version:0}))));
 const unsigned=compileTransaction(message),simulation=(await rpc('simulateTransaction',[getBase64EncodedWireTransaction(unsigned),{encoding:'base64',sigVerify:false,commitment:'confirmed'}])).value;
 if(simulation?.err!==null)throw new Error('Standard prefunded payment simulation failed before client signing.');
 const fee=(await rpc('getFeeForMessage',[Buffer.from(unsigned.messageBytes).toString('base64'),{commitment:'confirmed'}])).value;if(!Number.isSafeInteger(fee)||fee<0||fee>10000)throw new Error('Standard prefunded payment exceeds its fee cap.');
 assertLive();
 const signed=await partiallySignTransactionMessageWithSigners(message);
 if(!Buffer.from(signed.messageBytes).equals(Buffer.from(unsigned.messageBytes))||Object.keys(signed.signatures).length!==2||signed.signatures[address(sponsor)]!==null||!signed.signatures[signer.address]||!await verifySignature(await getPublicKeyFromAddress(signer.address),signed.signatures[signer.address]!,signed.messageBytes))throw new Error('Standard payment signer changed its original message or signer set.');
 return {wire:getBase64EncodedWireTransaction(signed),memo,sponsor,source,destination,scope,fundingSignature:input.fundingSignature};
}

/** Independently binds the finalized ordinary settlement to the original quote,
 * budget funding and durable client partial. Funding alone is not settlement. */
export async function verifyPrefundedX402Settlement(input:Base&{rpc:(method:string,params:unknown[])=>Promise<any>;fundingSignature:string;settlementSignature:string;partialWire:string;memo:string}){
 validate(input);
 if(typeof input.partialWire!=='string'||input.partialWire.length>2000||Buffer.from(input.partialWire,'base64').toString('base64')!==input.partialWire||typeof input.memo!=='string'||!input.memo||Buffer.byteLength(input.memo)>256||input.challenge.memo!==undefined&&input.memo!==input.challenge.memo)throw new Error('Original prefunded payment encoding or memo differs.');
 const original=getTransactionDecoder().decode(Buffer.from(input.partialWire,'base64')),decoded=getCompiledTransactionMessageDecoder().decode(original.messageBytes);
 if(decoded.version!==0||(decoded.addressTableLookups?.length??0)>0)throw new Error('Original prefunded payment requires a static v0 message.');
 const source=await tokenAddress(input.sessionKey),destination=await tokenAddress(input.recipient),sponsor=String(input.challenge.accepted.extra.feePayer);
 const expected=compileTransaction(appendTransactionMessageInstructions(ordinaryInstructions(source,destination,input.sessionKey,input.action.amount,input.memo),setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(decoded.lifetimeToken),lastValidBlockHeight:0n},setTransactionMessageFeePayer(address(sponsor),createTransactionMessage({version:0})))));
 if(!Buffer.from(original.messageBytes).equals(Buffer.from(expected.messageBytes)))throw new Error('Original prefunded transfer differs from its authorized quote.');
 if(await input.rpc('getGenesisHash',[])!==input.job.genesis)throw new Error('Prefunded settlement RPC belongs to another chain.');
 const scope=await prefundedX402Scope(input),funding=await verifyAutonomousTransaction(input.rpc,input.fundingSignature,input.job.program,scope.accounts,scope.paymentData,input.fundingFeePayer,input.sessionKey);
 const settlement=await verifySponsoredSettlement({rpc:input.rpc,genesis:input.job.genesis,signature:input.settlementSignature,partialWire:input.partialWire,sponsor,clientSigners:[input.sessionKey]});
 if(!Number.isSafeInteger(funding.slot)||funding.slot<0||!Number.isSafeInteger(settlement.slot)||settlement.slot<funding.slot)throw new Error('Prefunded settlement precedes its verified budget allocation.');
 return {scope,funding,settlement};
}

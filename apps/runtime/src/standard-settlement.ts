import { address,getTransactionDecoder,getCompiledTransactionMessageDecoder,getBase58Decoder,
 getPublicKeyFromAddress,verifySignature } from '@solana/kit';

type Rpc=(method:string,params:unknown[])=>Promise<any>;
/** Verify the sponsor only added its missing signature to our durable original.
 * The signing gateway must separately validate the original message's exact
 * authorized payment instructions before requesting any client signature. */
export async function verifySponsoredSettlement(input:{rpc:Rpc;genesis:string;signature:string;partialWire:string;
 sponsor:string;clientSigners:string[];maxFee?:number;allowedSponsorAccounts?:{instruction:number;account:number}[]}){
 const {rpc,genesis,signature,partialWire,sponsor,clientSigners}=input,maxFee=input.maxFee??10000;
 if(!Number.isSafeInteger(maxFee)||maxFee<0||maxFee>10000||partialWire.length>12000||!clientSigners.length||clientSigners.length>8||new Set([sponsor,...clientSigners]).size!==clientSigners.length+1)throw new Error('Invalid sponsored settlement scope.');
 if(await rpc('getGenesisHash',[])!==genesis)throw new Error('Settlement RPC belongs to another network.');
 const original=getTransactionDecoder().decode(Buffer.from(partialWire,'base64'));
 const message=getCompiledTransactionMessageDecoder().decode(original.messageBytes);
 if(message.version===1||'addressTableLookups' in message&&(message.addressTableLookups?.length??0)>0||message.staticAccounts[0]!==sponsor)throw new Error('Sponsored transaction has an unsupported message or fee payer.');
 const required=message.staticAccounts.slice(0,message.header.numSignerAccounts);
 if(required.length!==clientSigners.length+1||!clientSigners.every(key=>required.includes(address(key)))||original.signatures[address(sponsor)]!==null)throw new Error('Partial transaction does not match the pinned signer set.');
 // The exact payment constructor may permit a sponsor as a receiver at pinned
 // positions. Never accept arbitrary occurrences as source/authority/delegate.
 const allowed=input.allowedSponsorAccounts??[];
 if(allowed.length>4||allowed.some(position=>!Number.isSafeInteger(position.instruction)||!Number.isSafeInteger(position.account)||position.instruction<0||position.account<0||
  message.staticAccounts[message.instructions[position.instruction]?.accountIndices?.[position.account]??-1]!==sponsor))throw new Error('Invalid pinned sponsor receiver positions.');
 if(message.instructions.some((instruction,instructionIndex)=>(instruction.accountIndices??[]).some((index,accountIndex)=>message.staticAccounts[index]===sponsor&&
  !allowed.some(position=>position.instruction===instructionIndex&&position.account===accountIndex))))throw new Error('Sponsor cannot occur in unapproved payment instruction accounts.');
 for(const key of clientSigners){const signed=original.signatures[address(key)];
  if(!signed||!await verifySignature(await getPublicKeyFromAddress(address(key)),signed,original.messageBytes))throw new Error('Original client signature is missing or invalid.');}
 const result=await rpc('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
 if(!result||result.meta?.err!==null||!Number.isSafeInteger(result.meta.fee)||result.meta.fee<0||result.meta.fee>maxFee||
  !Array.isArray(result.transaction)||result.transaction[1]!=='base64'||typeof result.transaction[0]!=='string'||result.transaction[0].length>12000)throw new Error('Sponsored transaction is not a successful finalized settlement within its fee cap.');
 const settled=getTransactionDecoder().decode(Buffer.from(result.transaction[0],'base64'));
 if(!Buffer.from(settled.messageBytes).equals(Buffer.from(original.messageBytes)))throw new Error('Sponsor changed the original authorized transaction message.');
 const sponsorSignature=settled.signatures[address(sponsor)];
 if(!sponsorSignature||getBase58Decoder().decode(sponsorSignature)!==signature)throw new Error('Settlement receipt does not identify the original transaction.');
 for(const key of required){const signed=settled.signatures[key];
  if(!signed||!await verifySignature(await getPublicKeyFromAddress(key),signed,settled.messageBytes))throw new Error('Sponsored settlement signature is invalid.');
  if(key!==sponsor&&!Buffer.from(signed).equals(Buffer.from(original.signatures[key]!)))throw new Error('Sponsor replaced a client signature.');
 }
 return result;
}

import { randomBytes } from 'node:crypto';
import { address,addSignersToInstruction,appendTransactionMessageInstructions,compileTransaction,createTransactionMessage,
 getBase64EncodedWireTransaction,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,
 partiallySignTransactionMessageWithSigners,getTransactionDecoder,getPublicKeyFromAddress,verifySignature,type Instruction,type TransactionPartialSigner } from '@solana/kit';
import { autonomousServiceScope } from './autonomous-proof.js';
import type { AutonomousJob,AutonomousAction } from './autonomous-loop.js';
import type { StandardPaymentChallenge } from './standard-payments.js';

/** Constructs the already-authorized original only; never broadcasts or funds a wallet.
 * Session key pays Execution/ATA rent so the external sponsor pays network fees only. */
export async function prepareSponsoredServicePayment(input:{job:AutonomousJob;action:AutonomousAction;intentId:string;signer:TransactionPartialSigner;
 resultFeePayer:string;recipient:string;endpoint:string;challenge:Extract<StandardPaymentChallenge,{protocol:'x402'}>;
 rpc:(method:string,params:unknown[])=>Promise<any>}){
 const {job,action,intentId,signer,challenge,rpc}=input,sponsor=String(challenge.accepted.extra.feePayer);
 if(challenge.accepted.scheme!=='exact'||challenge.accepted.network!==`solana:${job.genesis.slice(0,32)}`||challenge.accepted.amount!==action.amount||
  challenge.accepted.asset!=='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'||challenge.accepted.payTo!==input.recipient||challenge.required.resource.url!==input.endpoint||
  await rpc('getGenesisHash',[])!==job.genesis)throw new Error('Sponsored quote differs from the fixed chain payment scope.');
 if(action.asset!=='USDC'||sponsor===signer.address||sponsor===job.agent||sponsor===job.session)throw new Error('Sponsored payment requires a distinct fee sponsor and the supported USDC asset.');
 const memo=challenge.memo??randomBytes(16).toString('hex');
 if(Buffer.byteLength(memo)>256)throw new Error('Sponsored memo exceeds its bounded payment reference.');
 const scope=await autonomousServiceScope({job,action,intentId,sessionKey:signer.address,feePayer:input.resultFeePayer,rentPayer:signer.address,recipient:input.recipient,endpoint:input.endpoint,memo});
 const instruction:Instruction={programAddress:address(job.program),accounts:scope.accounts.map((key,index)=>({address:address(key),role:[2,3,1,1,1,0,1,0,1,1,0,0,0][index]})),data:scope.paymentData};
 const lifetime=(await rpc('getLatestBlockhash',[{commitment:'confirmed'}])).value;
 const message=appendTransactionMessageInstructions([instruction,...scope.extra.map(item=>({programAddress:address(item.program),accounts:item.accounts.map(key=>({address:address(key),role:2 as const})),data:item.data}))].map(item=>addSignersToInstruction([signer],item)),
  setTransactionMessageLifetimeUsingBlockhash({...lifetime,lastValidBlockHeight:BigInt(lifetime.lastValidBlockHeight)},setTransactionMessageFeePayer(address(sponsor),createTransactionMessage({version:0}))));
 const unsigned=compileTransaction(message);
 const simulation=(await rpc('simulateTransaction',[getBase64EncodedWireTransaction(unsigned),{encoding:'base64',sigVerify:false,commitment:'confirmed'}])).value;
 if(simulation.err!==null)throw new Error('Sponsored payment simulation failed before signing; check Session rent reserve and chain authorization.');
 const fee=(await rpc('getFeeForMessage',[Buffer.from(unsigned.messageBytes).toString('base64'),{commitment:'confirmed'}])).value;
 if(!Number.isSafeInteger(fee)||fee<0||fee>10000)throw new Error('Sponsored payment exceeds its fee cap.');
 const signed=await partiallySignTransactionMessageWithSigners(message);
 if(!Buffer.from(signed.messageBytes).equals(Buffer.from(unsigned.messageBytes)))throw new Error('Wallet changed the authorized sponsored transaction.');
 const signature=signed.signatures[signer.address];
 if(!signature||signed.signatures[address(sponsor)]!==null||!await verifySignature(await getPublicKeyFromAddress(signer.address),signature,signed.messageBytes))throw new Error('Sponsored payment lacks its exact client signature.');
 const wire=getBase64EncodedWireTransaction(signed),decoded=getTransactionDecoder().decode(Buffer.from(wire,'base64'));
 if(Object.keys(decoded.signatures).length!==2)throw new Error('Sponsored payment requires unexpected signers.');
 return {wire,memo,sponsor,scope};
}

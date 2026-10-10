import { createHash } from 'node:crypto';
import { address,getAddressEncoder,getProgramDerivedAddress,getTransactionDecoder,getCompiledTransactionMessageDecoder,getSignatureFromTransaction,getPublicKeyFromAddress,verifySignature } from '@solana/kit';
import { workerDeliveryInput,workerDeliveryReceipt,type WorkerDeliveryInput,type WorkerDeliveryReceipt } from './worker-delivery-protocol.js';
const sha=(value:string)=>createHash('sha256').update(value).digest(),bytes=(key:string)=>Buffer.from(getAddressEncoder().encode(address(key)));
/** The caller separately pins RPC genesis, finalized metadata and the canonical
 * Escrow task/result commitment. This checks the exact signed delivery effect. */
export async function verifyWorkerDeliveryWire(program:string,worker:string,input:WorkerDeliveryInput,receipt:WorkerDeliveryReceipt,wire:string){
 input=workerDeliveryInput.parse(input);receipt=workerDeliveryReceipt.parse(receipt);
 if(receipt.tenant!==input.tenant||receipt.escrow!==input.escrow||receipt.taskHash!==input.taskHash||receipt.resultHash!==sha(input.result).toString('hex'))throw new Error('Worker delivery proof differs from the original request.');
 if(typeof wire!=='string'||wire.length>2000)throw new Error('Worker delivery wire exceeds its bound.');
 const tx=getTransactionDecoder().decode(Buffer.from(wire,'base64')),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 if(message.version!==0||message.instructions.length!==1||message.header.numSignerAccounts!==2||String(getSignatureFromTransaction(tx))!==receipt.signature)throw new Error('Worker delivery transaction identity differs.');
 const ix=message.instructions[0],keys=(ix.accountIndices??[]).map(index=>message.staticAccounts[index]),authority=keys[0],feePayer=message.staticAccounts[0];
 if(!authority||message.staticAccounts[ix.programAddressIndex]!==program||![authority,feePayer].every(key=>message.staticAccounts.slice(0,2).includes(key)))throw new Error('Worker delivery signers differ.');
 const derive=async(prefix:string,key:string)=>String((await getProgramDerivedAddress({programAddress:address(program),seeds:[Buffer.from(prefix),bytes(key)]}))[0]),session=String((await getProgramDerivedAddress({programAddress:address(program),seeds:[Buffer.from('session'),bytes(worker),bytes(authority)]}))[0]),count=Buffer.alloc(4);count.writeUInt32LE(input.sources.length);
 const expectedKeys=[authority,feePayer,worker,await derive('policy',worker),session,input.escrow,await derive('worker_delivery',input.escrow),input.sources.length?await derive('escrow_evidence',input.escrow):program,'11111111111111111111111111111111',...input.sources.map(source=>source.execution)],expectedData=Buffer.concat([sha('global:submit_session_escrow_result').subarray(0,8),sha(input.result),count,...input.sources.flatMap(source=>[bytes(source.execution),Buffer.from(source.contentHash,'hex')])]);
 if(keys.length!==expectedKeys.length||keys.some((key,index)=>key!==expectedKeys[index])||!Buffer.from(ix.data??[]).equals(expectedData))throw new Error('Worker delivery instruction differs from the original result and sources.');
 for(const key of message.staticAccounts.slice(0,2))if(!tx.signatures[key]||!await verifySignature(await getPublicKeyFromAddress(key),tx.signatures[key]!,tx.messageBytes))throw new Error('Worker delivery transaction signature is invalid.');
}

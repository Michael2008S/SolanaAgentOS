import { address,getTransactionDecoder,getCompiledTransactionMessageDecoder,getSignatureFromTransaction,getPublicKeyFromAddress,verifySignature } from '@solana/kit';
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { judgeRecordInput,type JudgeRecordInput } from './judge-record-protocol.js';
import { judgeSettlementReceipt,type JudgeSettlementReceipt } from './judge-settlement-protocol.js';
import { buildJudgedSettlementInstruction } from './headless-judge-settlement.js';
/** Caller separately verifies fresh genesis, finalized status/fee, canonical
 * parties and final Decision/Escrow state. */
export async function verifyJudgedSettlementWire(program:string,employer:string,worker:string,input:JudgeRecordInput,raw:JudgeSettlementReceipt,wire:string){
 input=judgeRecordInput.parse(input);const receipt=judgeSettlementReceipt.parse(raw);if(wire.length>2000||receipt.tenant!==input.tenant||receipt.escrow!==input.escrow||receipt.taskHash!==input.taskHash||receipt.resultHash!==input.resultHash||receipt.verdict!==input.judgment.verdict||receipt.judgmentHash!==createHash('sha256').update(canonicalJson(input.judgment)).digest('hex'))throw new Error('Settlement proof commitments differ.');
 const tx=getTransactionDecoder().decode(Buffer.from(wire,'base64')),m=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);if(m.version!==0||m.instructions.length!==1||m.header.numSignerAccounts!==1||String(getSignatureFromTransaction(tx))!==receipt.signature)throw new Error('Settlement proof identity differs.');
 const caller=m.staticAccounts[0],expected=await buildJudgedSettlementInstruction(program,caller,input,{employer,worker,asset:receipt.asset,amount:receipt.amount,destination:receipt.destination,execution:receipt.execution,task:receipt.task}),ix=m.instructions[0],keys=(ix.accountIndices??[]).map(i=>m.staticAccounts[i]);
 const destinationIndex=receipt.asset==='SOL'?(receipt.verdict==='pass'?7:6):(receipt.verdict==='pass'?9:8);if(receipt.destination!==expected.accounts![destinationIndex].address||receipt.decision!==expected.accounts![5].address)throw new Error('Settlement proof destination or decision differs.');
 if(m.staticAccounts[ix.programAddressIndex]!==program||keys.length!==expected.accounts!.length||keys.some((k,i)=>k!==expected.accounts![i].address)||!Buffer.from(ix.data??[]).equals(Buffer.from(expected.data!))||!tx.signatures[caller]||!await verifySignature(await getPublicKeyFromAddress(address(caller)),tx.signatures[caller]!,tx.messageBytes))throw new Error('Settlement proof instruction or signature differs.');
}

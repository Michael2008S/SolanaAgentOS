import test from 'node:test';
import assert from 'node:assert/strict';
import { address,blockhash,generateKeyPairSigner,createTransactionMessage,setTransactionMessageFeePayer,
 setTransactionMessageLifetimeUsingBlockhash,appendTransactionMessageInstructions,compileTransaction,
 getBase64EncodedWireTransaction,getBase58Decoder,type SignatureBytes } from '@solana/kit';
import { verifySponsoredSettlement } from './standard-settlement.js';

test('sponsored settlement preserves the original client-signed message and validates every signature',async()=>{
 const [sponsor,client,genesis]=await Promise.all(Array.from({length:3},()=>generateKeyPairSigner()));
 async function transaction(memo:string,includeSponsor=false){
  const message=appendTransactionMessageInstructions([{programAddress:address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
   accounts:[{address:client.address,role:2},...(includeSponsor?[{address:sponsor.address,role:1 as const}]:[])],data:Buffer.from(memo)}],
   setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(genesis.address),lastValidBlockHeight:10n},setTransactionMessageFeePayer(sponsor.address,createTransactionMessage({version:0}))));
  const unsigned=compileTransaction(message),clientSignature=new Uint8Array(await crypto.subtle.sign('Ed25519',client.keyPair.privateKey,new Uint8Array(unsigned.messageBytes))) as SignatureBytes;
  const partial={...unsigned,signatures:{...unsigned.signatures,[client.address]:clientSignature}};
  const sponsorSignature=new Uint8Array(await crypto.subtle.sign('Ed25519',sponsor.keyPair.privateKey,new Uint8Array(unsigned.messageBytes))) as SignatureBytes;
  const complete={...partial,signatures:{...partial.signatures,[sponsor.address]:sponsorSignature}};
  return {partial,complete,signature:getBase58Decoder().decode(sponsorSignature)};
 }
 const original=await transaction('original'),other=await transaction('replacement'),wrongAccount=await transaction('original',true);
 let current=original,fee=10000,network=genesis.address,err:unknown=null;
 const rpc=async(method:string)=>method==='getGenesisHash'?network:{meta:{err,fee},transaction:[getBase64EncodedWireTransaction(current.complete),'base64']};
 const input={rpc,genesis:genesis.address,signature:original.signature,partialWire:getBase64EncodedWireTransaction(original.partial),sponsor:sponsor.address,clientSigners:[client.address]};
 await verifySponsoredSettlement(input);
 current=other;await assert.rejects(verifySponsoredSettlement({...input,signature:other.signature}),/changed.*message/);current=original;
 fee=10001;await assert.rejects(verifySponsoredSettlement(input),/fee cap/);fee=10000;
 err={InstructionError:[0,'Custom']};await assert.rejects(verifySponsoredSettlement(input),/successful finalized/);err=null;
 network=client.address;await assert.rejects(verifySponsoredSettlement(input),/another network/);network=genesis.address;
 await assert.rejects(verifySponsoredSettlement({...input,partialWire:getBase64EncodedWireTransaction(original.complete)}),/pinned signer/);
 await assert.rejects(verifySponsoredSettlement({...input,clientSigners:[genesis.address]}),/pinned signer/);
 current=wrongAccount;
 const receiver={...input,signature:current.signature,partialWire:getBase64EncodedWireTransaction(current.partial)};
 await assert.rejects(verifySponsoredSettlement(receiver),/unapproved/);
 await verifySponsoredSettlement({...receiver,allowedSponsorAccounts:[{instruction:0,account:1}]});
 await assert.rejects(verifySponsoredSettlement({...receiver,allowedSponsorAccounts:[{instruction:5,account:1}]}),/receiver positions/);
 const corrupted={...wrongAccount.complete,signatures:{...wrongAccount.complete.signatures,[client.address]:new Uint8Array(64) as SignatureBytes}};
 const corruptRpc=async(method:string)=>method==='getGenesisHash'?network:{meta:{err:null,fee:10000},transaction:[getBase64EncodedWireTransaction(corrupted),'base64']};
 await assert.rejects(verifySponsoredSettlement({...receiver,rpc:corruptRpc,allowedSponsorAccounts:[{instruction:0,account:1}]}),/signature is invalid/);
});

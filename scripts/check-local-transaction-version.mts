import assert from 'node:assert/strict';
import { address, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction, getBase64EncodedWireTransaction, setTransactionMessageConfig } from '@solana/kit';
import { buildInitializeAgent } from '../apps/web/src/lib/agentOs.ts';
const rpcUrl=new URL(process.argv[2]||'http://127.0.0.1:18899');
const owner=address(process.argv[3]||'88cAm7hLj17dgRsz3pfGiRZ1mjx5frnGUEZj3QZAdPk4');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(rpcUrl.hostname));
async function rpc(method:string,params:unknown[]=[]) {const r=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return r.json();}
const genesis=(await rpc('getGenesisHash')).result;assert.notEqual(genesis,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
const init=await buildInitializeAgent(owner,'Unsigned version check',5,1,100,20,['api','payment','escrow']);
const lifetime=(await rpc('getLatestBlockhash')).result.value;
for(const version of [0,1] as const){
 let message=setTransactionMessageFeePayer(owner,createTransactionMessage({version}));
 if(version===1) message=setTransactionMessageConfig({computeUnitLimit:200_000,loadedAccountsDataSizeLimit:3_000_000},message) as typeof message;
 const tx=compileTransaction(appendTransactionMessageInstructions([init.instruction],setTransactionMessageLifetimeUsingBlockhash({...lifetime,lastValidBlockHeight:BigInt(lifetime.lastValidBlockHeight)},message)));
 const result=await rpc('simulateTransaction',[getBase64EncodedWireTransaction(tx),{encoding:'base64',sigVerify:false,commitment:'confirmed'}]);
 console.log(JSON.stringify({version,genesis,error:result.error||result.result?.value.err||null,units:result.result?.value.unitsConsumed,scope:'unsigned simulation; no state committed'}));
}

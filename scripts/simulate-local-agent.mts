import assert from 'node:assert/strict';
import { address, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction, getBase64EncodedWireTransaction } from '@solana/kit';
import { buildInitializeAgent, PROGRAM_ADDRESS } from '../apps/web/src/lib/agentOs.ts';
const endpoint='http://127.0.0.1:18899';
async function rpc(method: string, params: unknown[] = []) {
 const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
 const b=await r.json();if(!r.ok||b.error)throw new Error(JSON.stringify(b.error));return b.result;
}
assert.notEqual(await rpc('getGenesisHash'),'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
const owner=address('88cAm7hLj17dgRsz3pfGiRZ1mjx5frnGUEZj3QZAdPk4');
const initialized=await buildInitializeAgent(owner,'Local simulation',10,2,100,20,['api','payment','escrow']);
const lifetime=(await rpc('getLatestBlockhash')).value;
let message=setTransactionMessageFeePayer(owner,createTransactionMessage({version:0}));
message=setTransactionMessageLifetimeUsingBlockhash(lifetime,message);
const wire=getBase64EncodedWireTransaction(compileTransaction(appendTransactionMessageInstructions([initialized.instruction],message)));
const result=await rpc('simulateTransaction',[wire,{encoding:'base64',sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[initialized.accounts.agent]}}]);
console.log(JSON.stringify({program:PROGRAM_ADDRESS,scope:'unsigned simulation only; state not committed',result:result.value},null,2));
assert.equal(result.value.err,null,'Local initialize_agent simulation failed');
assert.equal(result.value.accounts[0].owner,PROGRAM_ADDRESS);
assert.equal(Buffer.from(result.value.accounts[0].data[0],'base64').length,138);

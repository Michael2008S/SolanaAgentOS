import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AutonomousGateway } from './autonomous-gateway.js';
import type { AutonomousJob } from './autonomous-loop.js';
test('recovery uses the result-only route and never invokes or pays a tool again',async()=>{
 const intentId=randomUUID(),action={key:'original',tool:'research',input:'Public query',asset:'SOL' as const,amount:'1'};
 const job={tenant:'owner',id:randomUUID(),intents:[{id:intentId,action,phase:'reserved'}]} as AutonomousJob;
 let verified=0;const methods:string[]=[];
 const gateway=new AutonomousGateway('http://127.0.0.1:19888/v1','local-gateway-credential-at-least-24',async()=>{verified++;throw new Error('Unused verifier');},async(url,init)=>{
  if(init?.method==='GET')assert.match(String(url),/\/v1\/results\/owner\//);else {assert.equal(String(url),'http://127.0.0.1:19888/v1/recover');const saved=JSON.parse(String(init?.body));assert.equal(saved.intentId,intentId);assert.deepEqual(saved.action,action);}methods.push(String(init?.method));return new Response(null,{status:404});
 });
 assert.equal(await gateway.reconcile(job,intentId),null);assert.deepEqual(methods,['GET','POST']);assert.equal(verified,0);
 await assert.rejects(()=>gateway.reconcile(job,randomUUID()),/Unknown/);assert.equal(methods.length,2);
});
test('gateway cannot redirect credentials, inject a signer URL or return another intent',async()=>{
 const intentId=randomUUID(),job={tenant:'owner',id:randomUUID(),intents:[]} as unknown as AutonomousJob,action={key:'a',tool:'research',input:'Public query',asset:'SOL' as const,amount:'1'};
 assert.throws(()=>new AutonomousGateway('http://example.com','x'.repeat(30),async()=>{throw new Error('unused');}),/requires HTTPS/);
 let verified=false;const gateway=new AutonomousGateway('https://gateway.example/v1','x'.repeat(30),async()=>{verified=true;throw new Error('unused');},async(_url,init)=>{
  assert.equal(init?.redirect,'error');return new Response(JSON.stringify({intentId:randomUUID(),execution:'A'.repeat(32),paymentSignature:'a'.repeat(64),resultSignature:'b'.repeat(64),content:'Original'}));
 });
 await assert.rejects(()=>gateway.execute(job,action,intentId),/another intent/);assert.equal(verified,false);
});

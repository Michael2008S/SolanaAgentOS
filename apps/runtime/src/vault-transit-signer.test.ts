import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSigner,getAddressEncoder,type TransactionPartialSigner } from '@solana/kit';
import { createVaultTransitSigner } from './vault-transit-signer.js';

test('Vault signer pins identity across reconnects and rejects unsafe keys and unverified signatures',async()=>{
 const wallet=await generateKeyPairSigner(),other=await generateKeyPairSigner();
 let mode='ok',reads=0,signs=0;
 const credential='private-fixture-credential';
 const server=createServer(async(req,res)=>{
  assert.equal(req.headers['x-vault-token'],credential);assert.equal(req.headers['x-vault-namespace'],'team/payments');
  res.setHeader('content-type','application/json');
  if(mode==='redirect'){res.writeHead(307,{location:'http://127.0.0.1:1/steal'}).end();return;}
  if(mode==='error'){res.writeHead(403).end(JSON.stringify({errors:[credential]}));return;}
  if(mode==='oversized'){res.end(' '.repeat(65537));return;}
  if(req.url==='/v1/transit/keys/session'){
   reads++;res.end(JSON.stringify({data:{type:'ed25519',derived:mode==='derived',exportable:mode==='exportable',allow_plaintext_backup:mode==='backup',supports_signing:true,min_encryption_version:mode==='rotated'?2:0,
    keys:{'1':{public_key:Buffer.from(getAddressEncoder().encode(mode==='wrong-key'?other.address:wallet.address)).toString('base64')}}}}));return;
  }
  assert.equal(req.url,'/v1/transit/sign/session');signs++;
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(body.key_version,1);assert.equal(body.prehashed,false);assert.deepEqual(Object.keys(body).sort(),['input','key_version','prehashed']);
  const message=Buffer.from(body.input,'base64'),signer=mode==='wrong-signature'?other:wallet;
  const signature=Buffer.from(await crypto.subtle.sign('Ed25519',signer.keyPair.privateKey,message)).toString('base64');
  res.end(JSON.stringify({data:{signature:'vault:v'+(mode==='wrong-version'?2:1)+':'+signature}}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const listener=server.address();assert.ok(listener&&typeof listener!=='string');
 const config={endpoint:'http://127.0.0.1:'+listener.port,key:'session',version:1,address:wallet.address,tokenEnv:'FIXTURE_TOKEN',namespace:'team/payments'};
 const transaction={messageBytes:new Uint8Array([1,2,3]),signatures:{[wallet.address]:null}} as unknown as Parameters<TransactionPartialSigner['signTransactions']>[0][number];
 try{
  const first=await createVaultTransitSigner(config,{FIXTURE_TOKEN:credential});
  const second=await createVaultTransitSigner(config,{FIXTURE_TOKEN:credential});assert.equal(first.address,second.address);
  assert.deepEqual(await first.signTransactions([transaction]),await second.signTransactions([transaction]));assert.equal(signs,2);
  for(const value of ['derived','exportable','backup','rotated','wrong-key']){mode=value;await assert.rejects(createVaultTransitSigner(config,{FIXTURE_TOKEN:credential}));}
  for(const value of ['wrong-signature','wrong-version']){mode=value;await assert.rejects(first.signTransactions([transaction]));}
  for(const value of ['redirect','error','oversized']){mode=value;await assert.rejects(createVaultTransitSigner(config,{FIXTURE_TOKEN:credential}),error=>error instanceof Error&&!error.message.includes(credential));}
  mode='ok';const previous=reads;
  await assert.rejects(first.signTransactions([{...transaction,signatures:{}}]));assert.equal(reads,previous);
  await assert.rejects(createVaultTransitSigner({...config,endpoint:'http://example.com'},{FIXTURE_TOKEN:credential}));
  await assert.rejects(createVaultTransitSigner({...config,key:'../export'},{FIXTURE_TOKEN:credential}));
  assert.equal(wallet.keyPair.privateKey.extractable,false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

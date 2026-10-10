import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateKeyPairSigner } from '@solana/kit';
import { HeadlessJournal,type HeadlessRecord } from './headless-journal.js';
test('public transaction journal never replaces a signed payment or original output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-headless-journal-')),file=join(root,'journal.sqlite'),journal=new HeadlessJournal(file);
 const original:HeadlessRecord={tenant:'owner',jobId:randomUUID(),intentId:randomUUID(),scopeHash:'a'.repeat(64),execution:'A'.repeat(32),complete:false,payment:{wire:'original-public-transaction',signature:'b'.repeat(64)}};
 try{journal.save(original);assert.throws(()=>new HeadlessJournal(file),/live gateway/);
 assert.throws(()=>journal.save({...original,payment:{...original.payment!,wire:'replacement-payment'}}),/cannot be replaced/);
 const delivered={...original,content:'Original output',result:{wire:'original-public-result',signature:'c'.repeat(64)},complete:true};journal.save(delivered);
 assert.throws(()=>journal.save({...delivered,content:'Changed output'}),/cannot be replaced/);
 assert.throws(()=>journal.save({...delivered,complete:false}),/cannot be reopened/);
 assert.equal(journal.load('another',original.jobId,original.intentId),null);assert.deepEqual(journal.load('owner',original.jobId,original.intentId),delivered);
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});
test('default gateway wallet keys cannot be exported',async()=>{
 const wallet=await generateKeyPairSigner();assert.equal(wallet.keyPair.privateKey.extractable,false);
 await assert.rejects(()=>crypto.subtle.exportKey('pkcs8',wallet.keyPair.privateKey));
});
test('sponsor partial message remains immutable across settlement and journal reopen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-sponsored-journal-')),file=join(root,'journal.sqlite');let journal=new HeadlessJournal(file);
 const original:HeadlessRecord={tenant:'owner',jobId:randomUUID(),intentId:randomUUID(),scopeHash:'a'.repeat(64),execution:'A'.repeat(32),complete:false,sponsoredPayment:{wire:'client-signed-public-wire',sponsor:'A'.repeat(32),memo:'fixed-invoice'},paymentChallenge:'original-challenge',paymentHeader:'original-credential'};
 try{journal.save(original);
 for(const field of ['wire','sponsor','memo'] as const)assert.throws(()=>journal.save({...original,sponsoredPayment:{...original.sponsoredPayment!,[field]:'B'.repeat(32)}}),/cannot be replaced/);
 assert.throws(()=>journal.save({...original,sponsoredPayment:undefined}),/cannot be replaced/);
 const settled={...original,payment:{wire:'same-message-with-sponsor-signature',signature:'b'.repeat(64)}};journal.save(settled);journal.close();journal=new HeadlessJournal(file);assert.deepEqual(journal.load('owner',original.jobId,original.intentId),settled);
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});

test('budget allocation is independently immutable and survives every original payment stage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-prefunded-journal-')),file=join(root,'journal.sqlite');let journal=new HeadlessJournal(file);
 const initial:HeadlessRecord={tenant:'owner',jobId:randomUUID(),intentId:randomUUID(),scopeHash:'a'.repeat(64),execution:'A'.repeat(32),complete:false,paymentChallenge:'original-quote',funding:{wire:'budget-allocation-wire',signature:'b'.repeat(64)}};
 try{
  journal.save(initial);journal.close();journal=new HeadlessJournal(file);assert.deepEqual(journal.load('owner',initial.jobId,initial.intentId),initial);
  const partial={...initial,sponsoredPayment:{wire:'standard-transfer-partial',sponsor:'B'.repeat(32),memo:'invoice'},paymentHeader:'original-standard-credential'};
  journal.save(partial);journal.close();journal=new HeadlessJournal(file);assert.deepEqual(journal.load('owner',initial.jobId,initial.intentId),partial);
  for(const funding of [undefined,{...initial.funding!,wire:'replacement'},{...initial.funding!,signature:'c'.repeat(64)}])assert.throws(()=>journal.save({...partial,funding}),/cannot be replaced/);
  const complete={...partial,payment:{wire:'sponsor-completed-transfer',signature:'d'.repeat(64)},content:'verified service answer',result:{wire:'result-commitment',signature:'e'.repeat(64)},complete:true};
  journal.save(complete);journal.close();journal=new HeadlessJournal(file);assert.deepEqual(journal.load('owner',initial.jobId,initial.intentId),complete);assert.equal(complete.funding!.signature,'b'.repeat(64));assert.equal(complete.payment.signature,'d'.repeat(64));
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});

test('response recovery attempts survive reopen, cannot reset or skip and stop at three',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-recovery-attempts-')),file=join(root,'journal.sqlite');let journal=new HeadlessJournal(file);
 const original:HeadlessRecord={tenant:'owner',jobId:randomUUID(),intentId:randomUUID(),scopeHash:'a'.repeat(64),execution:'A'.repeat(32),complete:false};
 try{journal.save(original);assert.throws(()=>journal.save({...original,responseRecoveries:2}),/advance/);
  journal.save({...original,responseRecoveries:1});journal.close();journal=new HeadlessJournal(file);
  assert.equal(journal.load('owner',original.jobId,original.intentId)!.responseRecoveries,1);
  assert.throws(()=>journal.save(original),/reset/);assert.throws(()=>journal.save({...original,responseRecoveries:3}),/advance/);
  journal.save({...original,responseRecoveries:2});journal.save({...original,responseRecoveries:3});journal.save({...original,responseRecoveries:3,content:'original'});
  assert.throws(()=>journal.save({...original,responseRecoveries:4}));
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});

test('Task result artifact is immutable, byte bounded and recovers escaped content after reopen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-artifact-')),file=join(root,'journal.sqlite');let journal=new HeadlessJournal(file);
 const original:HeadlessRecord={tenant:'owner',jobId:randomUUID(),intentId:randomUUID(),scopeHash:'a'.repeat(64),execution:'A'.repeat(32),complete:false,resultArtifact:'\\"'.repeat(200000)};
 try{journal.save(original);journal.close();journal=new HeadlessJournal(file);assert.equal(journal.load('owner',original.jobId,original.intentId)!.resultArtifact,original.resultArtifact);assert.throws(()=>journal.save({...original,resultArtifact:'changed'}),/cannot be replaced/);assert.throws(()=>journal.save({...original,resultArtifact:undefined}),/cannot be replaced/);assert.throws(()=>journal.save({...original,intentId:randomUUID(),resultArtifact:'中'.repeat(150001)}));
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});

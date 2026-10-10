import test from 'node:test';
import assert from 'node:assert/strict';
import {checkDeploymentReconciliation} from '../../scripts/reconcile-reviewed-deployment.mjs';

function fixture(){return {
 review:{network:'devnet',rpc:'https://api.devnet.solana.com',genesisHash:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',currentBalanceLamports:'60000000000'},
 attempts:[{signature:'first'},{signature:'last'},{signature:'missing',blockhash:'expired',phase:'write-buffer'}],
 receipts:[{signature:'first',phase:'initialize-buffer',slot:10,err:null,preBalance:60000000000,postBalance:59999990000},{signature:'last',phase:'deploy',slot:20,err:null,preBalance:59999990000,postBalance:59999980000}],
 history:[{signature:'last',slot:20,err:null,confirmationStatus:'finalized'}],statuses:[null],expiry:new Map([['expired',{value:false,slot:30}]]),balance:{value:59999980000,slot:30}
};}
test('reconciliation distinguishes expired absence from a successful receipt',()=>{const r=checkDeploymentReconciliation(fixture());assert.equal(r.status,'expired-with-no-finalized-record');assert.equal(r.finalized,2);assert.equal(r.expiredWithoutFinalizedRecord,1);assert.equal(r.accountedPayerDebitLamports,'20000');});
test('null signature alone cannot resolve an active or unchecked blockhash',()=>{for(const value of [true,undefined]){const f=fixture();f.expiry.set('expired',{value,slot:30});assert.throws(()=>checkDeploymentReconciliation(f),/blockhash remains valid/);}});
test('additional wallet effects or omitted original receipts reject accounting',()=>{const f=fixture();f.history[0].signature='unaccounted';assert.throws(()=>checkDeploymentReconciliation(f),/unaccounted effect/);const g=fixture();g.history=[];assert.throws(()=>checkDeploymentReconciliation(g),/Complete payer signature interval/);});
test('fee or rent balance discrepancy cannot be hidden behind null history',()=>{const f=fixture();f.balance.value-=5000;assert.throws(()=>checkDeploymentReconciliation(f),/does not reconcile/);});
test('recorded original status requires its receipt rather than negative classification',()=>{const f=fixture();f.statuses[0]={slot:15,err:null,confirmationStatus:'finalized'};assert.throws(()=>checkDeploymentReconciliation(f),/recorded status/);});
test('stale checkpoints and review balance substitutions are rejected',()=>{const f=fixture();f.expiry.set('expired',{value:false,slot:19});assert.throws(()=>checkDeploymentReconciliation(f),/checkpoint is too old/);const g=fixture();g.review.currentBalanceLamports='1';assert.throws(()=>checkDeploymentReconciliation(g),/balance differs/);});

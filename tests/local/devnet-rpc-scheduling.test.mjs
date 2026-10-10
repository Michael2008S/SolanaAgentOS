import test from 'node:test';import assert from 'node:assert/strict';
import {officialWorkflowUpstream} from '../../scripts/devnet-workflow-funding-rpc.mjs';
test('a slow read does not serialize all other reads; starts retain rate spacing and a four-request cap',async()=>{
 let release;const blocked=new Promise(done=>release=done),starts=[];let active=0,max=0;
 const transport=async(url,options)=>{assert.equal(url,'https://api.devnet.solana.com');const {method,id}=JSON.parse(options.body);starts.push(Date.now());active++;max=Math.max(max,active);if(method==='slow')await blocked;active--;return new Response(JSON.stringify({jsonrpc:'2.0',id,result:method}),{headers:{'content-type':'application/json'}});};
 const rpc=officialWorkflowUpstream({transport}),first=rpc('slow'),second=rpc('fast');try{assert.equal((await second).result,'fast');assert.ok(starts[1]-starts[0]>=300);assert.equal(max,2);}finally{release();}assert.equal((await first).result,'slow');
});
test('a failed send is attempted exactly once and releases the bounded slot',async()=>{
 let sends=0;const rpc=officialWorkflowUpstream({transport:async(_url,options)=>{const {method,id}=JSON.parse(options.body);if(method==='sendTransaction'){sends++;throw Error('Unknown transport');}return new Response(JSON.stringify({jsonrpc:'2.0',id,result:'read-only'}));}});await assert.rejects(rpc('sendTransaction',['public-wire',{encoding:'base64'}]),/transport unavailable/);assert.equal(sends,1);assert.equal((await rpc('getGenesisHash')).result,'read-only');
});
test('outgoing RPC concurrency is capped at four even with a queued burst',async()=>{
 let release;const blocked=new Promise(done=>release=done);let active=0,max=0,started=0;
 const rpc=officialWorkflowUpstream({transport:async(_url,options)=>{const {id}=JSON.parse(options.body);started++;active++;max=Math.max(max,active);await blocked;active--;return new Response(JSON.stringify({jsonrpc:'2.0',id,result:'ok'}));}});
 const calls=Array.from({length:6},()=>rpc('getAccountInfo'));try{await new Promise(done=>setTimeout(done,1250));assert.equal(started,4);assert.equal(max,4);}finally{release();}await Promise.all(calls);assert.equal(max,4);assert.equal(started,6);
});

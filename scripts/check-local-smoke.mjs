import assert from 'node:assert/strict';
const rpc=process.env.AGENTOS_LOCAL_RPC_URL || 'http://127.0.0.1:18899';
const runtime=process.env.AGENTOS_LOCAL_RUNTIME_URL || 'http://127.0.0.1:18787';
const web=process.env.AGENTOS_LOCAL_WEB_URL || 'http://127.0.0.1:15173';
for (const endpoint of [rpc,runtime,web]) {
 const url=new URL(endpoint);
 assert.ok(['http:','https:'].includes(url.protocol) && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) && !url.username && !url.password && !url.hash,'Local smoke endpoints must be loopback HTTP(S) URLs');
}
const subscriptions=new URL(process.env.VITE_SOLANA_WS_URL || rpc);
if(!process.env.VITE_SOLANA_WS_URL){subscriptions.protocol=subscriptions.protocol==='https:'?'wss:':'ws:';const rpcEndpoint=new URL(rpc);subscriptions.port=String(Number(rpcEndpoint.port || (rpcEndpoint.protocol==='https:'?443:80))+1);}
assert.ok(['ws:','wss:'].includes(subscriptions.protocol) && ['localhost','127.0.0.1','[::1]'].includes(subscriptions.hostname) && !subscriptions.username && !subscriptions.password && !subscriptions.hash,'Local smoke WebSocket must use loopback WS(S)');
async function request(method,params=[]) {
 const r=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
 assert.equal(r.ok,true);const body=await r.json();assert.equal(body.error,undefined);return body.result;
}
assert.equal(await request('getHealth'),'ok');
const genesis=await request('getGenesisHash');assert.notEqual(genesis,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
const program='HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv';
const account=await request('getAccountInfo',[program,{encoding:'base64',dataSlice:{offset:0,length:0}}]);assert.equal(account.value.executable,true);
for (const path of ['/api/health','/api/on-chain/skills','/api/on-chain/agents']) {
 const r=await fetch(runtime+path,{signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);const body=await r.json();assert.equal(body.network,'localnet-preview');
 if(path!='/api/health')assert.equal(body.programId,program);
 console.log(`PASS ${path}`);
}
await new Promise((resolve,reject)=>{
 const socket=new WebSocket(subscriptions);
 const finish=(error)=>{clearTimeout(timer);socket.close();error?reject(error):resolve();};
 const timer=setTimeout(()=>finish(new Error('Local WebSocket subscription timed out')),10000);
 socket.onopen=()=>socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'slotSubscribe',params:[]}));
 socket.onerror=()=>finish(new Error('Local WebSocket failed to connect'));
 socket.onmessage=({data})=>{try{const response=JSON.parse(String(data));if(response.id===1){assert.equal(response.error,undefined);assert.equal(typeof response.result,'number');finish();}}catch(error){finish(error);}};
});
console.log('PASS local WebSocket subscription');
const webResponse=await fetch(web,{signal:AbortSignal.timeout(10000)});
assert.equal(webResponse.status,200);assert.ok((await webResponse.text()).includes('id="root"'));
console.log('PASS web entry');
console.log(JSON.stringify({subscriptions:subscriptions.href,web,checkedAt:new Date().toISOString(),genesis,program,rpc,runtime,scope:'read-only local network and Runtime integration; no business transactions'},null,2));

import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSigner,getAddressDecoder} from '@solana/kit';
import {canonicalJson} from './canonical-json.js';
import {ServiceAnnouncementStore} from './service-announcements.js';
import {ServiceCatalogSync} from './service-catalog-sync.js';
import {WorkerProfileStore} from './worker-profiles.js';
import {WorkerProfileSync} from './worker-profile-sync.js';
const hash=(text:string)=>createHash('sha256').update(text).digest(),key=(text:string)=>getAddressDecoder().decode(hash(text));
for(const kind of ['service','profile'] as const)for(const ending of ['stop','deadline'] as const)test(kind+' real HTTP peers progress past a stalled page; '+ending+' discards its prefix',async(t)=>{
 if(ending==='deadline'){const timeout=AbortSignal.timeout.bind(AbortSignal);t.mock.method(AbortSignal,'timeout',(ms:number)=>timeout(ms===30000?1000:ms));}
 const signer=await generateKeyPairSigner(),now=Math.floor(Date.now()/1000),chain={programId:key('program'),genesis:key('genesis'),network:'localnet' as const},directory=await mkdtemp(join(tmpdir(),'catalog-lifecycle-'));
 const sign=async(payload:unknown)=>Buffer.from(await crypto.subtle.sign('Ed25519',signer.keyPair.privateKey,Buffer.from(canonicalJson(payload)))).toString('base64');
 const claims:any[]=[],records:any[]=[];
 for(let i=0;i<7;i++){
  if(kind==='service'){const service={skill:key('skill'+i),provider:signer.address,endpoint:'https://provider.example/'+i,name:'Research',description:'Public signed fixture',tags:[]},issuedAt=now-1,expiresAt=now+120;claims.push({...service,attestation:{issuedAt,expiresAt,genesis:chain.genesis,signature:await sign({domain:'agentos-service-metadata-v1',...chain,issuedAt,expiresAt,service})}});records.push({address:service.skill,provider:signer.address,endpointHash:hash(service.endpoint).toString('hex'),active:true,id:'Research',priceLamports:'1',priceUsdc:'0'});}
  else{const payload={domain:'agentos-worker-profile-v1',...chain,agent:key('agent'+i),owner:signer.address,issuedAt:now-1,expiresAt:now+120,profile:{description:'Public signed fixture',tags:[],languages:[],models:[],availability:'available',minimumSol:'0',minimumUsdc:'0'}};claims.push({payload,signature:await sign(payload)});records.push({address:payload.agent,owner:signer.address,active:true});}
 }
 let origin='',active=0,peak=0,stalled=false;
 const manifest=(claim:any,next?:string)=>kind==='service'?{format:'agentos-service-catalog',version:1,network:chain.network,programId:chain.programId,services:[claim],...(next?{next}:{})}:{format:'agentos-worker-profile-catalog',version:1,...chain,profiles:[claim],...(next?{next}:{})};
 const server=createServer((req,res)=>{active++;peak=Math.max(peak,active);res.on('close',()=>active--);const url=new URL(req.url!,origin);if(url.pathname==='/stall'&&url.search){stalled=true;return;}const index=url.pathname==='/stall'?0:Number(url.pathname.slice(1));res.setHeader('content-type','application/json');res.end(JSON.stringify(manifest(claims[index],index===0?origin+'/stall?page=2':undefined)));});
 server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+(server.address() as any).port;
 const store:any=kind==='service'?new ServiceAnnouncementStore(join(directory,'store.sqlite'),chain):new WorkerProfileStore(join(directory,'store.sqlite'),chain),urls=[origin+'/stall',...Array.from({length:6},(_,i)=>origin+'/'+(i+1))];
 const sync=kind==='service'?new ServiceCatalogSync({urls,chain:()=>chain,skills:async()=>records,store:()=>store}):new WorkerProfileSync({urls,chain:()=>chain,agents:async()=>records,store:()=>store});
 try{const poll=sync.sync();assert.equal(poll,sync.sync());for(let n=0;n<100&&(!stalled||store.loadAll().length!==6);n++)await new Promise(r=>setTimeout(r,10));assert.equal(stalled,true);assert.equal(store.loadAll().length,6);assert.ok(peak<=5);const started=Date.now();if(ending==='stop'){await sync.stop();assert.ok(Date.now()-started<2000,'Stop must cancel the live HTTP request');}const report=await poll;if(ending==='deadline')assert.ok(Date.now()-started<2000,'Per-catalog timeout must cancel the live HTTP request');await sync.stop();assert.equal(report.imported,6);assert.equal(report.failures.length,1);assert.equal(store.loadAll().length,6);await assert.rejects(sync.sync(),/stopped/);}finally{await sync.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await rm(directory,{recursive:true,force:true});}
});

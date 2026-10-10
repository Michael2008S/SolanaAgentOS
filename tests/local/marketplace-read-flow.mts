import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPairSigner } from '@solana/kit';
import { canonicalJson } from '../../apps/runtime/src/canonical-json.ts';
if(process.argv.length!==3||process.argv[2]!=='--run')throw new Error('Use --run for read-only Marketplace verification against the existing local validator.');
const quota=resolve('docs/evidence/deepseek-goal-20261009-quota.json'),before=await readFile(quota,'utf8');
const rpc='http://127.0.0.1:18899';
const genesisResponse=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getGenesisHash',params:[]})});
const {result:genesis}=await genesisResponse.json() as any;assert.equal(typeof genesis,'string');
const root=await mkdtemp(join(tmpdir(),'agentos-marketplace-')),directory=resolve('docs/evidence/marketplace-read-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory);
const program='HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv';
const child=spawn(process.execPath,['--import','tsx','apps/runtime/src/index.ts'],{cwd:process.cwd(),stdio:'ignore',env:{...process.env,
 PORT:'19787',AGENTOS_CLUSTER:'localnet',AGENTOS_LOCALNET_GENESIS_HASH:genesis,SOLANA_RPC_URL:rpc,AGENTOS_PROGRAM_ID:program,AGENTOS_DATA_DIR:root,
 AGENTOS_AUTONOMOUS_TENANTS:'',AGENTOS_WORKER_AUTORUN:'',AGENTOS_SERVICE_CATALOG_URL:'',AGENTOS_SERVICE_CATALOG_URLS:'[]'}});
const report:any={status:'running',readOnly:true,transactions:0,modelRequests:0};
try{
 for(let n=0;n<100;n++){try{const r=await fetch('http://127.0.0.1:19787/api/health');if(r.ok)break;}catch{}if(child.exitCode!==null)throw new Error('Read-only fixture Runtime exited.');await new Promise(resolve=>setTimeout(resolve,100));}
 const response=await fetch('http://127.0.0.1:19787/api/marketplace/workers');const workers=await response.json() as any;assert.ok(response.ok,JSON.stringify(workers));
 assert.equal(workers.genesis,genesis);assert.equal(workers.commitment,'finalized');assert.ok(workers.count>0);assert.equal(workers.count,workers.workers.length);assert.ok(workers.workers.every((worker:any)=>worker.recentReputation.halfLifeDays===90));
 await writeFile(join(directory,'workers.json'),JSON.stringify(workers,null,2)+'\n');
 const first=workers.workers[0],search=await (await fetch('http://127.0.0.1:19787/api/marketplace/workers?q='+encodeURIComponent(first.name))).json() as any;
 assert.ok(search.workers.some((worker:any)=>worker.address===first.address));
 const available=await (await fetch('http://127.0.0.1:19787/api/marketplace/workers?available=true')).json() as any;assert.equal(available.count,0);
 const fake=await generateKeyPairSigner(),issuedAt=Math.floor(Date.now()/1000),payload={domain:'agentos-worker-profile-v1',network:'localnet',programId:program,genesis,agent:first.address,owner:fake.address,issuedAt,expiresAt:issuedAt+100,
 profile:{description:'Unrelated Owner cannot publish this claim',tags:[],languages:[],models:[],availability:'available',minimumSol:'0',minimumUsdc:'0'}};
 const signature=Buffer.from(await crypto.subtle.sign('Ed25519',fake.keyPair.privateKey,Buffer.from(canonicalJson(payload)))).toString('base64');
 const rejected=await fetch('http://127.0.0.1:19787/api/marketplace/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload,signature})});assert.equal(rejected.status,400);assert.match((await rejected.json() as any).error,/Owner/);
 assert.equal(await readFile(quota,'utf8'),before);
 Object.assign(report,{status:'passed',workers:workers.count,finalizedJudgeOutcomes:workers.workers.reduce((sum:number,worker:any)=>sum+worker.recentReputation.acceptedOutcomes,0),ownerForgeryRejected:true,searchPassed:true,realModelQuotaUnchanged:true});
}catch(cause){report.status='failed';report.error=cause instanceof Error?cause.message:'Failed';process.exitCode=1;}
finally{child.kill('SIGTERM');if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');await rm(root,{recursive:true,force:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,evidence:directory}));}

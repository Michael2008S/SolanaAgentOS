import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const original=resolve('docs/evidence/background-role-pipeline-real-model-2026-10-10T05-58-12-015Z'),verifier=resolve('scripts/verify-background-role-pipeline.mts'),genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
test('original Localnet proof cannot become Devnet proof by renaming its network or stripping one identity marker',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-devnet-evidence-gate-'));
 try{
  for(const mode of ['genesis-only','renamed-network','plan-only']){
   const folder=join(root,mode);await cp(original,folder,{recursive:true});const report=JSON.parse(await readFile(join(folder,'report.json'),'utf8'));
   if(mode==='genesis-only'){report.genesis=genesis;delete report.network;}
   if(mode==='renamed-network'){report.genesis=genesis;report.network='devnet';report.plan.network='devnet';}
   if(mode==='plan-only'){report.plan.network='devnet';delete report.network;}
   await writeFile(join(folder,'report.json'),JSON.stringify(report));const run=spawnSync(process.execPath,['--import','tsx',verifier,folder],{encoding:'utf8',timeout:30000});assert.notEqual(run.status,0,'Localnet evidence must not pass the full Devnet acceptance gate.');
   assert.ok(mode==='renamed-network'?run.stderr.includes('all-transactions-report.json'):run.stderr.includes('Full official Devnet identity required.'),run.stderr);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

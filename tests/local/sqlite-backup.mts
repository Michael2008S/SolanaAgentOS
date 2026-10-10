import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const root=await mkdtemp(join(tmpdir(),'agentos-sqlite-check-'));
process.env.AGENTOS_CLUSTER='localnet';process.env.AGENTOS_DATA_DIR=root;process.env.AGENTOS_STORAGE_BACKEND='sqlite';
const source=join(root,'source.sqlite');const output=join(root,'backup.sqlite');process.env.AGENTOS_DATABASE_PATH=source;
const {RuntimeDatabase}=await import('../../apps/runtime/src/runtime-database.ts');
const programId='HWwd3RWsmiZ1uo1rd66oj3KaTXggW3B9zNUSFEUCbVzv';
const record={programId,id:'local-backup-fixture',note:'Storage-only fixture; not chain evidence'};
const checks:string[]=[];let db=await RuntimeDatabase.open();
try{
 assert.deepEqual(await db.restore('runtime-history',async()=>[record]),[record]);
 await db.replace('runtime-history',[{...record,note:'updated snapshot'}]);
 await assert.rejects(RuntimeDatabase.open(),/already owned/);checks.push('Live database owner rejects second Runtime');
 const run=promisify(execFile);const result=await run(process.execPath,['scripts/backup-runtime-db.mjs','--database',source,'--output',output]);const receipt=JSON.parse(result.stdout);
 assert.equal(receipt.output,output);assert.equal(receipt.sha256,createHash('sha256').update(await readFile(output)).digest('hex'));assert.equal(receipt.collections[0].count,1);checks.push('Online snapshot has matching SHA-256 and collection count');
 await assert.rejects(run(process.execPath,['scripts/backup-runtime-db.mjs','--database',source,'--output',output]));checks.push('Backup refuses to overwrite existing destination');
 db.close();process.env.AGENTOS_DATABASE_PATH=output;db=await RuntimeDatabase.open();assert.deepEqual(await db.restore('runtime-history',async()=>{throw new Error('Should not remigrate');}),[{...record,note:'updated snapshot'}]);checks.push('Restored snapshot preserves exact record without migration');
 await db.replace('runtime-history',[{...record,note:'restored branch'}]);db.close();process.env.AGENTOS_DATABASE_PATH=source;db=await RuntimeDatabase.open();assert.deepEqual(await db.restore('runtime-history',async()=>[]),[{...record,note:'updated snapshot'}]);checks.push('Restored copy changes cannot modify source database');
 await writeFile(join(root,'report.json'),JSON.stringify({passed:true,checkedAt:new Date().toISOString(),checks,scope:'SQLite storage-only fixtures; no transactions, chain assertions or models',root},null,2));console.log(JSON.stringify({passed:true,checks,report:join(root,'report.json')},null,2));
}finally{db.close();}

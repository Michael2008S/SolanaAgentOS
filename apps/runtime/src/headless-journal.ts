import { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { chmodSync,closeSync,lstatSync,mkdirSync,openSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import * as z from 'zod/v4';

const transaction=z.object({wire:z.string().max(2000),signature:z.string().min(64).max(88)}).strict();
export const sponsoredPaymentSchema=z.object({wire:z.string().max(2000),sponsor:z.string().min(32).max(44),memo:z.string().refine(value=>Buffer.byteLength(value)<=256)}).strict();
const schema=z.object({tenant:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),jobId:z.string().uuid(),intentId:z.string().uuid(),scopeHash:z.string().regex(/^[a-f0-9]{64}$/),
  authorizationScopeHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),funding:transaction.optional(),payment:transaction.optional(),sponsoredPayment:sponsoredPaymentSchema.optional(),paymentHeader:z.string().max(20000).optional(),paymentChallenge:z.string().max(20000).optional(),content:z.string().max(65536).optional(),result:transaction.optional(),
  resultArtifact:z.string().refine(value=>Buffer.byteLength(value)<=450000).optional(),responseRecoveries:z.number().int().min(0).max(3).optional(),complete:z.boolean(),execution:z.string().min(32).max(44)}).strict();
export type HeadlessRecord=z.infer<typeof schema>;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Contains signed public transactions and provider outputs, never wallet keys.
 * Exactly one local gateway owns this file. PID recovery is transactional. */
export class HeadlessJournal {
 private readonly db:DatabaseSync;
 private readonly owner=randomUUID();
 constructor(file:string){
  mkdirSync(dirname(file),{recursive:true,mode:0o700});try{const fd=openSync(file,'wx',0o600);closeSync(fd);}catch(cause){if((cause as NodeJS.ErrnoException).code!=='EEXIST')throw cause;}
  const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>200_000_000)throw new Error('Invalid headless journal.');chmodSync(file,0o600);
  this.db=new DatabaseSync(file,{timeout:1000});
  try{
   const app=this.db.prepare('PRAGMA application_id').get()?.application_id,version=this.db.prepare('PRAGMA user_version').get()?.user_version;
   const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
   if(app===0&&version===0&&!tables.length)this.db.exec(`BEGIN IMMEDIATE;CREATE TABLE records(tenant TEXT NOT NULL,job_id TEXT NOT NULL,intent_id TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(tenant,job_id,intent_id)) STRICT;CREATE TABLE owner(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL) STRICT;PRAGMA application_id=1095190359;PRAGMA user_version=1;COMMIT;`);
   else if(app!==1095190359||version!==1)throw new Error('Headless journal belongs to another application.');
   this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA trusted_schema=OFF;BEGIN IMMEDIATE;');
   const old=this.db.prepare('SELECT pid,host FROM owner WHERE id=1').get();
   if(old){if(old.host!==hostname()||typeof old.pid!=='number'||old.pid<=0)throw new Error('Headless journal is owned by another host.');let alive=true;try{process.kill(old.pid,0);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ESRCH')alive=false;}if(alive)throw new Error('Headless journal already has a live gateway.');}
   this.db.prepare('INSERT INTO owner(id,token,pid,host) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,host=excluded.host').run(this.owner,process.pid,hostname());this.db.exec('COMMIT');
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}this.db.close();throw error;}
 }
 load(tenant:string,jobId:string,intentId:string):HeadlessRecord|null{
  const row=this.db.prepare('SELECT body,hash FROM records WHERE tenant=? AND job_id=? AND intent_id=?').get(tenant,jobId,intentId);if(!row)return null;
  if(typeof row.body!=='string'||Buffer.byteLength(row.body)>2_000_000||hash(row.body)!==row.hash)throw new Error('Headless record is corrupt.');
  const value=schema.parse(JSON.parse(row.body));if(value.tenant!==tenant||value.jobId!==jobId||value.intentId!==intentId)throw new Error('Headless identity differs.');return value;
 }
 save(input:HeadlessRecord){
  const value=schema.parse(input),body=JSON.stringify(value);if(Buffer.byteLength(body)>2_000_000)throw new Error('Headless record exceeds its limit.');
  this.db.exec('BEGIN IMMEDIATE');try{
   if(this.db.prepare('SELECT token FROM owner WHERE id=1').get()?.token!==this.owner)throw new Error('Headless journal ownership changed.');
   const old=this.load(value.tenant,value.jobId,value.intentId);if(old&&(old.scopeHash!==value.scopeHash||old.execution!==value.execution))throw new Error('Intent cannot change its original execution scope.');
   if(old)for(const field of ['authorizationScopeHash','funding','payment','sponsoredPayment','paymentHeader','paymentChallenge','content','result','resultArtifact'] as const)if(old[field]!==undefined&&JSON.stringify(old[field])!==JSON.stringify(value[field]))throw new Error('Original signed transaction or provider output cannot be replaced.');
   const before=old?.responseRecoveries??0,after=value.responseRecoveries??0;
   if(after<before||after>before+1)throw new Error('Response recovery attempts must advance once and cannot reset.');
   if(old?.complete&&!value.complete)throw new Error('A completed intent cannot be reopened.');
   if(!old&&Number(this.db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count)>=10000)throw new Error('Headless journal is full.');
   this.db.prepare('INSERT INTO records(tenant,job_id,intent_id,body,hash) VALUES(?,?,?,?,?) ON CONFLICT(tenant,job_id,intent_id) DO UPDATE SET body=excluded.body,hash=excluded.hash').run(value.tenant,value.jobId,value.intentId,body,hash(body));this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 close(){this.db.prepare('DELETE FROM owner WHERE id=1 AND token=?').run(this.owner);this.db.close();}
}
